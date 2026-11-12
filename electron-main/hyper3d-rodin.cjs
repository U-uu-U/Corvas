// Hyper3D Rodin adapter. Wire facts come from docs/api/hyper3d-rodin.md; the adapter contract is docs/model3d-providers.md.
const { httpRequest, submitFailure, queryFailure, readFailure, model3dError, isAbortError, normalizeModel3dRequest, loadModel3dImage,
    encodeMultipart, model3dOutput, assertApiKey, resolveBaseUrl, redact } = require('./model3d-common.cjs');

const HYPER3D = Object.freeze({
    id: 'hyper3d',
    name: 'Hyper3D',
    docs: 'docs/api/hyper3d-rodin.md',
    baseUrl: 'https://api.hyper3d.com/api/v2',
    modes: Object.freeze(['text', 'image', 'multiview']),
    formats: Object.freeze(['glb', 'usdz', 'fbx', 'obj', 'stl']),
    defaultModel: 'Gen-2.5-Medium',
    models: Object.freeze([
        { id: 'Gen-2.5-Extreme-Low', label: 'Gen-2.5 Extreme Low' },
        { id: 'Gen-2.5-Low', label: 'Gen-2.5 Low' },
        { id: 'Gen-2.5-Medium', label: 'Gen-2.5 Medium' },
        { id: 'Gen-2.5-High', label: 'Gen-2.5 High' },
        { id: 'Gen-2.5-Extreme-High', label: 'Gen-2.5 Extreme High' },
        { id: 'Gen-2', label: 'Gen-2' },
        { id: 'Sketch', label: 'Gen-1/1.5 Sketch' },
        { id: 'Regular', label: 'Gen-1/1.5 Regular' },
        { id: 'Detail', label: 'Gen-1/1.5 Detail' },
        { id: 'Smooth', label: 'Gen-1/1.5 Smooth' }
    ].map(Object.freeze)),
    // multiview: /rodin takes up to 5 images, but the unified request only has four views.
    // targetFaces is the outer quality_override range of all tiers; the lower per-tier and Quad caps are left to the server.
    // There is no image size or format entry: the documentation states neither for /rodin.
    limits: Object.freeze({ promptMax: 1024, multiview: Object.freeze([2, 4]), targetFaces: Object.freeze([500, 2000000]), seedMax: 65535 }),
    maxWaitMs: 20 * 60 * 1000,
    supportsCancel: false,
    supportsImageUrl: false
});
const NAME = HYPER3D.name;
// The create request carries the image uploads, so it gets more time than a status call.
const SUBMIT_TIMEOUT_MS = 2 * 60 * 1000;
// Keeps a huge local file from being read into memory. Not a documented limit; the server applies its own.
const IMAGE_MAX_BYTES = 50 * 1024 * 1024;

// Error codes a create call returns in the body of an HTTP 201 response. Any other code maps to `rejected`.
const REJECTION_KINDS = new Map([
    ['API_INSUFFICIENT_FUNDS', 'credits'],
    ['API_PARALLELISM_LIMIT_REACHED', 'rateLimited'],
    ['IMAGE_CONTENT_VIOLATION', 'content'],
    ['API_NO_ACTIVE_SUBSCRIPTION', 'forbidden'],
    ['API_SUBSCRIPTION_PLAN_TOO_LOW', 'forbidden'],
    ['PERMISSION_DENIED', 'forbidden']
]);

// Form fields of POST /rodin for a normalized request. providerOptions go in first so unified fields win.
function buildRodinFields(request) {
    const fields = { ...request.providerOptions };
    if ('images' in fields) throw model3dError('invalid', NAME, { detail: '参考图请用 images 传入，不能放在 providerOptions 里' });
    // tier is always sent: without it the server falls back to Regular, a Gen-1/1.5 tier.
    fields.tier = request.model || fields.tier || HYPER3D.defaultModel;
    if (request.prompt) fields.prompt = request.prompt;
    // 'All' and 'Hybrid' both include the PBR maps and have no unified field, so they are kept when PBR is wanted.
    fields.material = !request.texture ? 'None' : !request.pbr ? 'Shaded' : ['All', 'Hybrid'].includes(fields.material) ? fields.material : 'PBR';
    if (request.topology) fields.mesh_mode = request.topology === 'quad' ? 'Quad' : 'Raw';
    if (request.targetFaces !== null) fields.quality_override = request.targetFaces;
    fields.geometry_file_format = request.format;
    if (request.seed !== null) fields.seed = request.seed;
    return fields;
}

// Multipart parts of POST /rodin. `images` are loadModel3dImage results in upload order; the first one drives the material.
function buildRodinParts(fields, images = []) {
    const parts = images.map((image, index) => ({ name: 'images', filename: `image-${index + 1}.${image.ext}`,
        contentType: image.mime, data: image.buffer }));
    for (const [name, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        // No array is encoded here: the documentation has no multipart example for bbox_condition, image_label
        // or addons, and the two official clients write them differently ("[1, 2, 3]" and "1,2,3").
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
            throw model3dError('invalid', NAME, { detail: `参数 ${name} 只能是文本、数字或布尔值；数组请自己写成字符串` });
        }
        parts.push({ name, value });
    }
    return parts;
}

// A task has one or more jobs: it succeeds when every job is Done and fails as soon as one is Failed.
function rodinStatus(jobs) {
    const statuses = Array.isArray(jobs) ? jobs.map(job => job?.status) : [];
    if (statuses.includes('Failed')) return 'failed';
    if (!statuses.length || statuses.some(status => !['Waiting', 'Generating', 'Done'].includes(status))) return 'unknown';
    if (statuses.every(status => status === 'Done')) return 'succeeded';
    return statuses.every(status => status === 'Waiting') ? 'queued' : 'running';
}

// Download list entries only have a name and a URL; the model in the requested format goes first.
function rodinOutputs(list, format) {
    const outputs = (Array.isArray(list) ? list : []).map(file => model3dOutput({ url: file?.url, name: file?.name })).filter(Boolean);
    const wanted = output => output.role === 'model' && output.format === format;
    return [...outputs.filter(wanted), ...outputs.filter(output => !wanted(output))];
}

// Error code and readable text of a response body. The key is masked in case a gateway echoes the request back.
function remoteError(response, apiKey) {
    const { error, message } = response.json || {};
    const code = typeof error === 'string' ? redact(error, [apiKey]) : '';
    const http = response.status >= 200 && response.status < 300 ? '' : `HTTP ${response.status}`;
    const detail = redact([http, error, message].filter(part => part && typeof part === 'string').join(' '), [apiKey]);
    return { code, detail: detail || `HTTP ${response.status}`, remoteCode: code || null };
}

function createHyper3dProvider({ apiKey, baseUrl, fetchImpl } = {}) {
    const key = assertApiKey(apiKey, NAME);
    const base = resolveBaseUrl(baseUrl, HYPER3D.baseUrl, NAME);
    const auth = { Authorization: `Bearer ${key}` };
    // A fetch implementation may quote the request headers in its error text.
    const masked = error => Object.assign(error, { message: redact(error.message, [key]) });

    async function submit(request, { signal } = {}) {
        const normalized = normalizeModel3dRequest(request, { ...HYPER3D.limits, formats: HYPER3D.formats }, NAME);
        const fields = buildRodinFields(normalized);
        const images = [];
        for (const image of normalized.images) {
            // Rodin only documents multipart file uploads, so a URL input is rejected instead of being passed on.
            images.push(await loadModel3dImage(image.source, { provider: NAME, allowUrl: false, maxBytes: IMAGE_MAX_BYTES }));
        }
        const { body, contentType } = encodeMultipart(buildRodinParts(fields, images));
        let response;
        try {
            response = await httpRequest(fetchImpl, { method: 'POST', url: `${base}/rodin`,
                headers: { ...auth, 'Content-Type': contentType }, body, timeoutMs: SUBMIT_TIMEOUT_MS, signal });
        } catch (transport) {
            throw submitFailure(NAME, { transport: masked(transport) });
        }
        const { uuid: taskId, jobs, consumed, error } = response.json || {};
        // A 2xx only means the request was processed: a rejected submission is 201 with an `error` code in the body.
        // The documentation says 201; the official ComfyUI client also accepts 200, and a task ID must never be dropped.
        const processed = response.status >= 200 && response.status < 300;
        if (!processed || error) {
            const { code, detail, remoteCode } = remoteError(response, key);
            // Only a plain error code without a task proves the rejection. "Unexpected server error", an error
            // next to a task uuid or an error that is not a code leave open whether a task was created.
            const definite = code && code !== 'API_UNKNOWN' && !taskId;
            const kind = !processed ? undefined : definite ? REJECTION_KINDS.get(code) || 'rejected' : 'submissionUnknown';
            throw submitFailure(NAME, { response, kind, detail, remoteCode });
        }
        const subscriptionKey = jobs?.subscription_key;
        if (!taskId || typeof taskId !== 'string' || !subscriptionKey || typeof subscriptionKey !== 'string') {
            throw model3dError('invalidResponse', NAME, { detail: '提交已被受理，但响应缺少任务 ID 或查询凭据', status: response.status,
                submissionUnknown: true });
        }
        // taskId (top-level uuid) is only valid for /download, subscriptionKey only for /status.
        return { provider: HYPER3D.id, taskId, stage: 'generate', format: normalized.format, next: null, history: [], baseUrl: base, subscriptionKey,
            creditsConsumed: typeof consumed === 'number' ? consumed : null };
    }

    // POST for /status and /download. Both report a missing or expired task as NO_SUCH_TASK in the body.
    async function post(path, body, signal) {
        let response;
        try {
            response = await httpRequest(fetchImpl, { method: 'POST', url: `${base}${path}`,
                headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
        } catch (transport) {
            throw queryFailure(NAME, { transport: masked(transport) });
        }
        const { code, ...extras } = remoteError(response, key);
        if (code === 'NO_SUCH_TASK') throw model3dError('taskNotFound', NAME, { ...extras, status: response.status });
        if (response.status < 200 || response.status >= 300) throw queryFailure(NAME, { response, ...extras });
        if (code) throw model3dError('statusUnavailable', NAME, { ...extras, status: response.status, transient: true });
        return response.json || {};
    }

    async function query(handle, { signal } = {}) {
        if (handle?.provider !== HYPER3D.id || handle.baseUrl !== base || !handle.taskId || !handle.subscriptionKey) {
            // A broken record says nothing about the task itself, which may still be running.
            throw model3dError('invalid', NAME, { detail: '任务记录不完整，或不是在当前 API 地址创建的', confirmedFailure: false });
        }
        const { jobs, message } = await post('/status', { subscription_key: handle.subscriptionKey }, signal);
        const state = rodinStatus(jobs);
        const remoteStatus = Array.isArray(jobs) ? [...new Set(jobs.map(job => String(job?.status ?? '')))].filter(Boolean).join(',') : '';
        const status = { state, progress: null, remoteStatus: remoteStatus || null, outputs: [], error: null,
            creditsConsumed: handle.creditsConsumed ?? null, expiresAt: null, retryAfterMs: null };
        if (state === 'failed') {
            // /status has no failure reason field, only an optional top-level message.
            status.error = { code: null, retryable: false,
                message: redact(typeof message === 'string' ? message : '', [key]) || '服务商没有返回失败原因' };
        }
        if (state === 'succeeded') {
            const { list } = await post('/download', { task_uuid: handle.taskId }, signal);
            status.outputs = rodinOutputs(list, handle.format);
            // A finished task without files is not a usable result, so polling retries instead of reporting success.
            if (!status.outputs.length) throw model3dError('statusUnavailable', NAME, { detail: '任务已完成，但暂时没有拿到下载文件', transient: true });
        }
        return status;
    }

    async function balance({ signal } = {}) {
        let response;
        try {
            response = await httpRequest(fetchImpl, { url: `${base}/check_balance`, headers: auth, signal });
        } catch (error) {
            throw readFailure(NAME, { transport: isAbortError(error) ? error : masked(error) });
        }
        const { balance: amount, ...rest } = response.json || {};
        if (response.status === 200 && !rest.error && typeof amount === 'number') return { balance: amount, unit: 'credits', detail: rest };
        const { code, detail, remoteCode } = remoteError(response, key);
        // check_balance needs Full API access, so a Basic key is refused with one of the subscription codes.
        if (REJECTION_KINDS.has(code)) throw model3dError(REJECTION_KINDS.get(code), NAME, { detail, remoteCode, status: response.status });
        if (response.status !== 200) throw readFailure(NAME, { response, detail, remoteCode });
        throw model3dError('invalidResponse', NAME, { detail, remoteCode, status: response.status });
    }

    // Rodin takes the face count, topology and format at submission, so there is never a second billable stage.
    const nextStage = () => null;
    const advance = async () => { throw model3dError('unsupported', NAME, { detail: 'Rodin 只有一个生成阶段' }); };
    const cancel = async () => ({ supported: false, canceled: false, detail: 'Hyper3D 没有取消任务的接口' });
    // Official guidance: status checks at least 5 s apart at first, backing off to at most 30 s.
    const pollDelayMs = attempt => Math.min(30000, Math.round(5000 * 1.5 ** Math.max(0, Number(attempt) || 0)));

    return { info: HYPER3D, submit, query, nextStage, advance, cancel, balance, pollDelayMs };
}

module.exports = { HYPER3D, createHyper3dProvider, buildRodinFields, buildRodinParts, rodinStatus, rodinOutputs };
