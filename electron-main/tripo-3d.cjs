// Tripo v3 adapter. Every wire detail comes from docs/api/tripo-3d.md; the adapter contract is docs/model3d-providers.md.
const { httpRequest, submitFailure, queryFailure, readFailure, model3dError, isAbortError, throwIfAborted, normalizeModel3dRequest,
    loadModel3dImage, encodeMultipart, extensionOf, model3dOutput, isPlainObject, assertApiKey, resolveBaseUrl, retryAfterMs,
    redact } = require('./model3d-common.cjs');

const NAME = 'Tripo';
const REGIONS = Object.freeze({ global: 'https://openapi.tripo3d.ai/v3', cn: 'https://openapi.tripo3d.com/v3' });
const TRIPO = Object.freeze({
    id: 'tripo',
    name: NAME,
    docs: 'docs/api/tripo-3d.md',
    baseUrl: REGIONS.global,
    regions: REGIONS,
    modes: Object.freeze(['text', 'image', 'multiview']),
    formats: Object.freeze(['glb', 'fbx', 'obj', 'usdz', 'stl', '3mf', 'gltf']),
    // The API has no server-side default and rejects a request without `model`.
    defaultModel: 'v3.1-20260211',
    models: Object.freeze([
        Object.freeze({ id: 'v3.1-20260211', label: 'H3.1' }),
        Object.freeze({ id: 'v3.0-20250812', label: 'H3.0' }),
        Object.freeze({ id: 'v2.5-20250123', label: 'H2.5' }),
        Object.freeze({ id: 'P2-20260801', label: 'P2' }),
        Object.freeze({ id: 'P1-20260311', label: 'P1' })
    ]),
    // No targetFaces range: it depends on the model, quad and geometry_quality, so the server validates it.
    limits: Object.freeze({ promptMax: 1024, multiview: Object.freeze([2, 4]), imageMaxBytes: 20 * 1024 * 1024,
        imageFormats: Object.freeze(['jpeg', 'png', 'webp']) }),
    maxWaitMs: 20 * 60 * 1000,
    supportsCancel: false,
    supportsImageUrl: true
});

const GENERATION_PATHS = Object.freeze({ text: '/generation/text-to-model', image: '/generation/image-to-model',
    multiview: '/generation/multiview-to-model' });
const TRIPO_STATES = Object.freeze({ queued: 'queued', running: 'running', success: 'succeeded', failed: 'failed',
    banned: 'failed', expired: 'failed', cancelled: 'canceled' });
const SUBMIT_CODE_KINDS = Object.freeze({ 2010: 'credits', 2008: 'content', 1007: 'rateLimited', 2000: 'rateLimited' });
const OUTPUT_FORMATS = Object.freeze([...TRIPO.formats, 'zip']);
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;

// `request` is a normalized request; `inputs` holds one URL or file_token per request.images entry, in the same order.
function buildTripoGenerationBody(request, inputs = []) {
    // `pbr` defaults to true on the server and forces `texture` on, so both are always sent.
    const body = { ...request.providerOptions, model: request.model || TRIPO.defaultModel, texture: request.texture, pbr: request.pbr };
    // Never `quad: false`: parameters a model does not support must be omitted, P1 rejects the key itself.
    if (request.topology === 'quad') body.quad = true;
    else if (request.topology === 'triangle' || body.quad === false) delete body.quad;
    if (request.targetFaces !== null) body.face_limit = request.targetFaces;
    if (request.seed !== null) body.model_seed = request.seed;
    if (request.mode === 'text') body.prompt = request.prompt;
    else if (request.mode === 'image') body.input = inputs[0];
    else body.inputs = request.images.map((image, index) => ({ [image.view]: inputs[index] }));
    return body;
}

// `input` is always the generation task and is added by advance, so a caller's value never reaches the handle.
function buildTripoConvertBody(format, options = {}) {
    const body = { ...options, format: String(format).toUpperCase() };
    delete body.input;
    return body;
}

// Used only when model_url has no usable extension. H-series `quad` forces FBX; the docs do not say
// what P2 returns for quad, so P-series is assumed to stay GLB.
const generatedFormat = body => (body.quad === true && !/^p/i.test(body.model) ? 'fbx' : 'glb');
// A convert task returns the requested format, except that quad forces FBX and FBX can be packaged as a zip.
const convertedFormat = (body, format) => (body.texture_packaging === 'zip' ? 'zip' : body.quad === true ? 'fbx' : format);

function tripoTaskError(task, remoteStatus) {
    const code = task.error_code ?? null;
    const content = code === 2008 || remoteStatus === 'banned';
    const timedOut = code === 2018 || remoteStatus === 'expired';
    // The main documentation names the field error_message; both official SDKs also read error_msg.
    return { code, message: content ? '内容未通过审核' : redact(task.error_message || task.error_msg) || (timedOut ? '任务超时' : '任务失败'),
        retryable: timedOut };
}

// `data` is the `data` object of GET /tasks/{id}.
function tripoStatus(data, handle = {}) {
    const task = isPlainObject(data) ? data : {};
    const remoteStatus = String(task.status ?? '');
    // "unknown" and unlisted values are neither success nor failure: polling continues until the deadline.
    const state = Object.hasOwn(TRIPO_STATES, remoteStatus) ? TRIPO_STATES[remoteStatus] : 'unknown';
    const output = state === 'succeeded' && isPlainObject(task.output) ? task.output : {};
    const extension = extensionOf(output.model_url);
    const format = OUTPUT_FORMATS.includes(extension) ? extension : handle.expectedFormat || 'glb';
    return {
        state,
        progress: state === 'succeeded' ? 100 : Number.isFinite(task.progress) ? Math.min(100, Math.max(0, task.progress)) : null,
        remoteStatus,
        outputs: [model3dOutput({ url: output.model_url, role: 'model', format }),
            model3dOutput({ url: output.rendered_image_url, role: 'thumbnail' })].filter(Boolean),
        error: state === 'failed' ? tripoTaskError(task, remoteStatus) : null,
        creditsConsumed: Number.isFinite(task.credits_consumed) ? task.credits_consumed : null,
        expiresAt: null,
        retryAfterMs: null
    };
}

// Called for a create response that was not accepted. A success code under a failing status contradicts
// itself, so a task may exist. 429 means the request was not processed. 503 is documented that way only
// together with Retry-After; without the header it is treated like 500, 502 and 504, and 408 and 425 leave
// the outcome unknown too. Error codes are trusted only below 500: a 5xx body does not prove that no task
// was created. Everything else is left to submitFailure's status mapping. `retryAfter` is retryAfterMs(headers).
function tripoSubmitKind(status, code, retryAfter = null) {
    if (code === 0) return 'submissionUnknown';
    if (status === 429 || (status === 503 && retryAfter !== null)) return 'rateLimited';
    if (status === 408 || status === 425) return 'submissionUnknown';
    return status < 500 && Object.hasOwn(SUBMIT_CODE_KINDS, code) ? SUBMIT_CODE_KINDS[code] : undefined;
}

const accepted = response => response.status >= 200 && response.status < 300 && response.json?.code === 0;

function createTripoProvider({ apiKey, baseUrl, region, fetchImpl } = {}) {
    const key = assertApiKey(apiKey, NAME);
    const regionName = region || 'global';
    if (!Object.hasOwn(REGIONS, regionName)) throw model3dError('invalid', NAME, { detail: '区域必须是 global 或 cn' });
    const root = resolveBaseUrl(baseUrl, REGIONS[regionName], NAME);

    // Every request that carries the key goes through here, so the key only reaches the configured API address.
    async function send(path, { contentType, ...options } = {}) {
        try {
            return await httpRequest(fetchImpl, { ...options, url: `${root}${path}`,
                headers: { Authorization: `Bearer ${key}`, ...(contentType ? { 'Content-Type': contentType } : {}) } });
        } catch (error) {
            throw Object.assign(error, { message: redact(error.message, [key]) });
        }
    }

    // `code` is documented as an integer. Anything else is left out of the error's properties, which are not redacted.
    const failure = response => {
        const { code, message } = isPlainObject(response.json) ? response.json : {};
        return { remoteCode: Number.isInteger(code) ? code : null,
            detail: redact(`HTTP ${response.status}${code === undefined ? '' : ` code ${code}`}${message ? ` ${message}` : ''}`, [key]) };
    };

    // A value JSON cannot carry (a BigInt, a cycle) is rejected before anything is sent.
    function toJson(value) {
        try { return JSON.stringify(value); } catch {
            throw model3dError('invalid', NAME, { detail: 'providerOptions 和 stageOptions 必须能序列化为 JSON' });
        }
    }

    // A task lives in the region that created it and a key is valid in one region only, so a handle is used
    // only with the API address it was created on. An edited handle therefore cannot redirect the key either.
    function assertHandle(handle) {
        if (typeof handle?.taskId !== 'string' || !handle.taskId || handle.provider !== TRIPO.id || handle.baseUrl !== root) {
            // The record cannot be used here, but its task may still be running.
            throw model3dError('invalid', NAME, { detail: '任务记录无效，或不是在当前 API 地址（区域）创建的', confirmedFailure: false });
        }
    }

    // One create request, never repeated. The body is serialized first, so the only errors mapped as
    // a transport failure are the ones raised by the exchange itself.
    async function createTask(path, body, signal) {
        const payload = toJson(body);
        throwIfAborted(signal);
        let response;
        try { response = await send(path, { method: 'POST', body: payload, contentType: 'application/json', signal }); } catch (error) {
            throw submitFailure(NAME, { transport: error });
        }
        if (!accepted(response)) {
            throw submitFailure(NAME, { response, ...failure(response),
                kind: tripoSubmitKind(response.status, response.json?.code, retryAfterMs(response.headers)) });
        }
        const taskId = response.json.data?.task_id;
        if (typeof taskId !== 'string' || !taskId) {
            throw model3dError('invalidResponse', NAME, { detail: '创建响应缺少 task_id', submissionUnknown: true });
        }
        return taskId;
    }

    // Uploads happen before any task exists, so every failure here is confirmed and nothing is billed.
    async function uploadExchange(exchange) {
        try { return await exchange; } catch (error) {
            throw isAbortError(error) ? error : model3dError('upload', NAME, { detail: error.timedOut ? '上传超时' : '上传连接中断' });
        }
    }

    async function uploadCall(path, options) {
        const response = await uploadExchange(send(path, { method: 'POST', ...options, timeoutMs: UPLOAD_TIMEOUT_MS }));
        if (!accepted(response)) {
            throw model3dError(response.status === 401 ? 'auth' : 'upload', NAME, { ...failure(response), status: response.status,
                retryable: response.status === 429 || response.status >= 500, retryAfterMs: retryAfterMs(response.headers) });
        }
        const data = response.json.data;
        if (typeof data?.file_token !== 'string' || !data.file_token) throw model3dError('upload', NAME, { detail: '上传响应缺少 file_token' });
        return data;
    }

    // Tripo rejects base64 input, so local bytes are uploaded and referenced by file_token.
    async function uploadImage(image, signal) {
        // POST /files documents JPEG and PNG only; WebP is listed for the presigned flow.
        if (image.mime !== 'image/webp') {
            // A neutral ASCII name: the local file name is private and may hold characters a form header cannot carry safely.
            const form = encodeMultipart([{ name: 'file', filename: `image.${image.ext}`, contentType: image.mime, data: image.buffer }]);
            return (await uploadCall('/files', { body: form.body, contentType: form.contentType, signal })).file_token;
        }
        const data = await uploadCall('/files/presign', { body: JSON.stringify({ format: 'webp' }), contentType: 'application/json', signal });
        const target = data.presigned_url || data.upload_url;
        if (typeof target !== 'string' || !/^https:\/\//i.test(target)) throw model3dError('upload', NAME, { detail: '上传响应缺少上传地址' });
        // The storage URL signs itself: no Authorization header, and it never appears in an error.
        const put = await uploadExchange(httpRequest(fetchImpl, { method: 'PUT', url: target, body: image.buffer,
            headers: { 'Content-Type': 'application/octet-stream' }, timeoutMs: UPLOAD_TIMEOUT_MS, signal }));
        if (put.status < 200 || put.status >= 300) throw model3dError('upload', NAME, { detail: `HTTP ${put.status}`, status: put.status });
        return data.file_token;
    }

    async function submit(request, { signal } = {}) {
        throwIfAborted(signal);
        const normalized = normalizeModel3dRequest(request, { ...TRIPO.limits, formats: TRIPO.formats }, NAME);
        const convertOptions = normalized.stageOptions.convert;
        if (convertOptions !== undefined && !isPlainObject(convertOptions)) {
            throw model3dError('invalid', NAME, { detail: 'stageOptions.convert 必须是对象' });
        }
        toJson(normalized.providerOptions);
        // A generation returns one file, GLB unless quad forced FBX. Other formats need a convert task.
        // Its body is kept as plain JSON data, so the handle is the same after it has been saved and read back.
        const next = normalized.format === 'glb' ? null
            : { stage: 'convert', body: JSON.parse(toJson(buildTripoConvertBody(normalized.format, convertOptions))) };
        // Every image is checked before the first upload, so an invalid request never sends anything.
        const images = [];
        for (const { source } of normalized.images) {
            images.push(await loadModel3dImage(source, { provider: NAME, maxBytes: TRIPO.limits.imageMaxBytes,
                formats: TRIPO.limits.imageFormats.map(format => `image/${format}`) }));
        }
        const inputs = [];
        for (const image of images) inputs.push(image.url || await uploadImage(image, signal));
        const body = buildTripoGenerationBody(normalized, inputs);
        // The rest of the handle is built before the request: nothing may fail once a billable task exists.
        const rest = { stage: 'generate', format: normalized.format, next, history: [], baseUrl: root, expectedFormat: generatedFormat(body) };
        return { provider: TRIPO.id, taskId: await createTask(GENERATION_PATHS[normalized.mode], body, signal), ...rest };
    }

    // `failed` is queryFailure for a task (a failed read says nothing about the task itself) or readFailure for the balance.
    async function read(path, signal, failed) {
        let response;
        try { response = await send(path, { signal }); } catch (error) { throw failed(NAME, { transport: error }); }
        if (!accepted(response)) throw failed(NAME, { response, ...failure(response) });
        return response.json.data;
    }

    async function query(handle, { signal } = {}) {
        assertHandle(handle);
        return tripoStatus(await read(`/tasks/${encodeURIComponent(handle.taskId)}`, signal, queryFailure), handle);
    }

    // Decided from the file the task really produced: quad on an H-series model already returns FBX.
    function nextStage(handle, status) {
        const model = status?.state === 'succeeded' ? status.outputs?.find(output => output.role === 'model') : null;
        if (!handle?.next || !model || model.format === handle.format) return null;
        return { stage: handle.next.stage };
    }

    async function advance(handle, status, { signal } = {}) {
        assertHandle(handle);
        // A convert task is billed, so it is only created for a finished model that is not in the requested format.
        if (!nextStage(handle, status) || handle.next.stage !== 'convert' || !isPlainObject(handle.next.body)) {
            throw model3dError('invalid', NAME, { detail: '任务记录没有待提交的阶段' });
        }
        // Built before the request for the same reason as in submit: a damaged `history` in a saved record
        // must not lose the id of a convert task that was just created.
        const rest = { stage: 'convert', format: handle.format, next: null,
            history: [...(Array.isArray(handle.history) ? handle.history : []), { stage: handle.stage, taskId: handle.taskId }],
            baseUrl: root, expectedFormat: convertedFormat(handle.next.body, handle.format) };
        return { provider: TRIPO.id, taskId: await createTask('/models/convert', { ...handle.next.body, input: handle.taskId }, signal), ...rest };
    }

    async function cancel() {
        return { supported: false, canceled: false, detail: 'Tripo 没有取消任务的接口' };
    }

    async function balance({ signal } = {}) {
        const data = await read('/account/balance', signal, readFailure);
        if (!Number.isFinite(data?.balance)) throw model3dError('invalidResponse', NAME, { detail: '余额响应缺少 balance' });
        return { balance: data.balance, unit: 'credits', detail: { frozen: data.frozen ?? null } };
    }

    return { info: TRIPO, submit, query, nextStage, advance, cancel, balance, pollDelayMs: () => 2000 };
}

module.exports = { TRIPO, createTripoProvider, buildTripoGenerationBody, buildTripoConvertBody, tripoStatus, tripoSubmitKind };
