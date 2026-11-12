// Meshy adapter for the provider-neutral 3D interface (docs/model3d-providers.md).
// Every path, field and status used here is taken from docs/api/meshy-3d.md.
const { httpRequest, submitFailure, queryFailure, readFailure, model3dError, normalizeModel3dRequest, loadModel3dImage, toDataUri,
    model3dOutput, assertApiKey, resolveBaseUrl, retryAfterMs, redact, isPlainObject } = require('./model3d-common.cjs');

const NAME = 'Meshy';
const MESHY = Object.freeze({
    id: 'meshy',
    name: NAME,
    docs: 'docs/api/meshy-3d.md',
    baseUrl: 'https://api.meshy.ai/openapi',
    modes: Object.freeze(['text', 'image', 'multiview']),
    formats: Object.freeze(['glb', 'fbx', 'obj', 'usdz', 'stl', '3mf']),
    defaultModel: 'latest',
    models: Object.freeze([
        { id: 'latest', label: '最新标准模型（当前为 Meshy 7.1）' },
        { id: 'meshy-7.1', label: 'Meshy 7.1' },
        { id: 'meshy-6', label: 'Meshy 6' },
        { id: 'meshy-6-lite', label: 'Meshy 6 Lite' },
        { id: 'meshy-t2.5', label: 'Meshy T2.5（Smart Topology 低面数，不支持多视图）' },
        { id: 'meshy-t2', label: 'Meshy T2（Smart Topology 低面数，不支持多视图）' },
        { id: 'meshy-7', label: 'Meshy 7（已废弃，2026-12-31 下线）' }
    ].map(Object.freeze)),
    limits: Object.freeze({ promptMax: 800, multiview: Object.freeze([1, 4]), targetFaces: Object.freeze([100, 300000]),
        imageMaxBytes: 20 * 1024 * 1024, imageFormats: Object.freeze(['jpeg', 'png', 'webp']) }),
    maxWaitMs: 60 * 60 * 1000,
    supportsCancel: true,
    supportsImageUrl: true
});

// Path prefix per handle.kind. A task must be queried on the prefix it was created on.
const PATHS = Object.freeze({ 'text-to-3d': '/v2/text-to-3d', 'image-to-3d': '/v1/image-to-3d',
    'multi-image-to-3d': '/v1/multi-image-to-3d' });
// Smart Topology models and the largest target_polycount each one accepts.
const SMART_TOPOLOGY_FACES = Object.freeze({ 'meshy-t2': 15000, 'meshy-t2.5': 30000 });
const STATES = Object.freeze({ PENDING: 'queued', IN_PROGRESS: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed',
    CANCELED: 'canceled' });
const TASK_ERROR_TYPES = Object.freeze({
    invalid_input: { text: '输入不符合要求', retryable: false },
    timeout: { text: '服务端处理或排队超时', retryable: true },
    service_unavailable: { text: '服务暂时不可用', retryable: true },
    server_error: { text: '服务内部错误', retryable: true }
});
const CANNOT_CANCEL_RUNNING = '任务已开始生成，Meshy 不能取消运行中的任务，积分不退';

const ok = response => response.status >= 200 && response.status < 300;

// Remote text may echo the input, so data URIs are cut out before it is shown.
const remoteText = (value, secrets) => (typeof value === 'string' ? redact(value.replace(/data:[^\s"']+/gi, 'data:…'), secrets) : '');

// True when a JSON value holds an inline file anywhere: a string that is a data URI or carries base64 data.
const INLINE_DATA = /^\s*data:[^\s,]*,|;base64,/i;
const hasInlineData = value => (typeof value === 'string' ? INLINE_DATA.test(value)
    : Boolean(value) && typeof value === 'object' && Object.entries(value).flat().some(hasInlineData));

// Unified geometry fields. Standard models reach a topology or face count through the remesh stage.
// Smart Topology models generate at the face count directly: they need model_type, ignore should_remesh,
// only produce triangles, and do not exist on multi-image-to-3d (`smartTopology` false).
function geometryFields(request, smartTopology) {
    const fields = {};
    if (request.model) fields.ai_model = request.model;
    if (Object.hasOwn(SMART_TOPOLOGY_FACES, request.model)) {
        const maxFaces = SMART_TOPOLOGY_FACES[request.model];
        if (!smartTopology) throw model3dError('unsupported', NAME, { detail: `多视图不支持 ${request.model}` });
        if (request.topology === 'quad') throw model3dError('invalid', NAME, { detail: `${request.model} 只能生成三角面` });
        if (request.targetFaces > maxFaces) throw model3dError('invalid', NAME, { detail: `${request.model} 的目标面数最多 ${maxFaces}` });
        fields.model_type = 'smart-topology';
    } else if (request.topology || request.targetFaces !== null) {
        fields.should_remesh = true;
    }
    if (request.topology) fields.topology = request.topology;
    if (request.targetFaces !== null) fields.target_polycount = request.targetFaces;
    return fields;
}

// Shared by image-to-3d and multi-image-to-3d. `images` is { image_url } or { image_urls }.
function generateBody(request, images, smartTopology) {
    const body = { ...request.providerOptions, ...images, ...geometryFields(request, smartTopology),
        should_texture: request.texture, target_formats: [request.format] };
    // enable_pbr without texturing is rejected with 400.
    if (request.texture) body.enable_pbr = request.pbr;
    else delete body.enable_pbr;
    // Meshy would use input_task_id instead of the images given here; only one of the two may be sent.
    delete body.input_task_id;
    return body;
}

// All builders take a request that has been through normalizeModel3dRequest. request.seed is not mapped:
// no Meshy documentation page has a seed parameter, so submit rejects it.
function buildMeshyTextBody(request) {
    const body = { ...request.providerOptions, mode: 'preview', prompt: request.prompt, ...geometryFields(request, true) };
    // The docs do not say which preview files refine reads, so a preview that will be refined keeps every format.
    if (request.texture) delete body.target_formats;
    else body.target_formats = [request.format];
    return body;
}

// The refine body without preview_task_id, which is only known once the preview has succeeded.
function buildMeshyRefineBody(request) {
    return { ...request.stageOptions.refine, mode: 'refine', enable_pbr: request.pbr, target_formats: [request.format] };
}

// The refine body waits in the handle until the preview has succeeded, so it has to be plain JSON without image data.
function storedRefineBody(request) {
    const refine = request.stageOptions.refine;
    let body;
    // The copy that is stored is the one JSON gives back, so what a restart reads is what was checked here.
    try { body = JSON.parse(JSON.stringify(buildMeshyRefineBody(request))); } catch { /* reported below */ }
    if ((refine != null && !isPlainObject(refine)) || !isPlainObject(body) || hasInlineData(body)) {
        throw model3dError('invalid', NAME, { detail: 'stageOptions.refine 必须是能写成 JSON 的对象，其中的图片只能用网络地址' });
    }
    return body;
}

const buildMeshyImageBody = (request, imageUrl) => generateBody(request, { image_url: imageUrl }, true);

const buildMeshyMultiviewBody = (request, imageUrls) => generateBody(request, { image_urls: imageUrls }, false);

function meshyOutputs(task, format) {
    const entry = (url, fields) => (typeof url === 'string' ? model3dOutput({ url, ...fields }) : null);
    // Keys such as pre_remeshed_glb are not format names; their format is read from the URL.
    const models = Object.entries(isPlainObject(task.model_urls) ? task.model_urls : {}).map(([key, url]) =>
        entry(url, { role: 'model', format: MESHY.formats.includes(key) || key === 'mtl' ? key : undefined, name: key }));
    const textures = (Array.isArray(task.texture_urls) ? task.texture_urls : []).filter(isPlainObject)
        .flatMap(maps => Object.entries(maps).map(([name, url]) => entry(url, { role: 'texture', name })));
    return [...models.filter(output => output?.name === format), ...models.filter(output => output?.name !== format),
        ...textures, entry(task.thumbnail_url, { role: 'thumbnail' })].filter(Boolean);
}

// Maps a Meshy task object to the unified status. Only `status` decides failure: a finished task may
// carry a non-null task_error, and any field other than id, status and progress may be missing.
function meshyStatus(task, format, retryAfter = null, secrets = []) {
    const state = Object.hasOwn(STATES, task.status) ? STATES[task.status] : 'unknown';
    let error = null;
    if (state === 'failed') {
        const remote = isPlainObject(task.task_error) ? task.task_error : {};
        const type = Object.hasOwn(TASK_ERROR_TYPES, remote.type) ? TASK_ERROR_TYPES[remote.type] : null;
        error = { code: remoteText(remote.code, secrets) || remoteText(remote.type, secrets) || 'FAILED',
            message: [type?.text || '任务失败', remoteText(remote.message, secrets)].filter(Boolean).join('：'),
            retryable: Boolean(type?.retryable) };
    }
    return { state, progress: Number.isFinite(task.progress) ? Math.min(100, Math.max(0, task.progress)) : null,
        remoteStatus: remoteText(task.status, secrets),
        outputs: state === 'succeeded' ? meshyOutputs(task, format) : [], error,
        creditsConsumed: Number.isFinite(task.consumed_credits) ? task.consumed_credits : null,
        expiresAt: Number(task.expires_at) > 0 ? Number(task.expires_at) : null, retryAfterMs: retryAfter };
}

function createMeshyProvider({ apiKey, baseUrl, fetchImpl } = {}) {
    const key = assertApiKey(apiKey, NAME);
    const base = resolveBaseUrl(baseUrl, MESHY.baseUrl, NAME);

    // Request errors carry a single `message`.
    const remoteMessage = response => remoteText(response.json?.message, [key]) || `HTTP ${response.status}`;

    // `body` is JSON text. Only this function sends the key, and only to the configured base.
    async function call(method, path, { body, timeoutMs = 30000, signal, failure }) {
        const headers = { Authorization: `Bearer ${key}` };
        if (body) headers['Content-Type'] = 'application/json';
        try {
            return await httpRequest(fetchImpl, { method, url: `${base}${path}`, headers, body, timeoutMs, signal });
        } catch (transport) {
            // A fetch implementation may quote the request, headers included, in its error text.
            transport.message = redact(transport.message, [key]);
            throw failure(NAME, { transport });
        }
    }

    // The handle records the API address the task lives on. It is only compared, never used to build a request:
    // a task created through another address is not there to query, and an edited handle cannot move the key.
    const record = (kind, stage, taskId, format, next, history) =>
        ({ provider: MESHY.id, taskId, stage, format, next, history, kind, baseUrl: base });

    function taskPath(handle) {
        if (handle?.provider !== MESHY.id || handle.baseUrl !== base || typeof handle.taskId !== 'string' || !handle.taskId
            || !Object.hasOwn(PATHS, handle.kind)) {
            // The record cannot be used here, but its task may still be running.
            throw model3dError('invalid', NAME, { detail: '任务记录无效，或不是在当前 API 地址创建的', confirmedFailure: false });
        }
        return `${PATHS[handle.kind]}/${encodeURIComponent(handle.taskId)}`;
    }

    // One POST, never repeated: Meshy has no idempotency key and bills when the task is created.
    async function create(kind, body, signal) {
        let json;
        // Serialized before the exchange: a body that cannot be sent is a local error, not an unknown submission.
        try { json = JSON.stringify(body); } catch { throw model3dError('invalid', NAME, { detail: '请求参数不能写成 JSON' }); }
        const response = await call('POST', PATHS[kind], { body: json, timeoutMs: 60000, signal, failure: submitFailure });
        if (!ok(response)) throw submitFailure(NAME, { response, detail: remoteMessage(response) });
        const taskId = response.json?.result;
        if (typeof taskId !== 'string' || !taskId) {
            throw model3dError('invalidResponse', NAME, { detail: '创建请求已被接受，但响应里没有任务 ID', status: response.status,
                submissionUnknown: true });
        }
        return taskId;
    }

    async function imageUrl(source) {
        const image = await loadModel3dImage(source, { provider: NAME, maxBytes: MESHY.limits.imageMaxBytes,
            formats: MESHY.limits.imageFormats.map(format => `image/${format}`) });
        return image.url || toDataUri(image);
    }

    async function submit(input, { signal } = {}) {
        const request = normalizeModel3dRequest(input, { ...MESHY.limits, formats: MESHY.formats }, NAME);
        if (request.seed !== null) throw model3dError('unsupported', NAME, { detail: '官方文档页没有随机种子参数' });
        // Everything that can fail locally runs before create(): nothing may throw once a task exists.
        if (request.mode === 'text') {
            const next = request.texture ? { stage: 'refine', body: storedRefineBody(request) } : null;
            const taskId = await create('text-to-3d', buildMeshyTextBody(request), signal);
            return record('text-to-3d', 'preview', taskId, request.format, next, []);
        }
        const urls = await Promise.all(request.images.map(image => imageUrl(image.source)));
        const [kind, body] = request.mode === 'image' ? ['image-to-3d', buildMeshyImageBody(request, urls[0])]
            : ['multi-image-to-3d', buildMeshyMultiviewBody(request, urls)];
        return record(kind, 'generate', await create(kind, body, signal), request.format, null, []);
    }

    async function query(handle, { signal } = {}) {
        const response = await call('GET', taskPath(handle), { signal, failure: queryFailure });
        if (!ok(response)) throw queryFailure(NAME, { response, detail: remoteMessage(response) });
        if (!isPlainObject(response.json) || typeof response.json.status !== 'string') {
            throw model3dError('invalidResponse', NAME, { detail: '查询响应里没有任务状态', transient: true });
        }
        return meshyStatus(response.json, handle.format, retryAfterMs(response.headers), [key]);
    }

    const nextStage = (handle, status) => (handle?.next && status?.state === 'succeeded' ? { stage: handle.next.stage } : null);

    async function advance(handle, status, { signal } = {}) {
        const next = nextStage(handle, status);
        if (!next || !isPlainObject(handle.next.body)) throw model3dError('invalid', NAME, { detail: '当前任务没有可提交的后续阶段' });
        taskPath(handle); // Rejects a handle that is not a Meshy task on this API address.
        // Read before the request: nothing may throw once the refine task exists.
        const history = [...(Array.isArray(handle.history) ? handle.history : []), { stage: handle.stage, taskId: handle.taskId }];
        const taskId = await create(handle.kind, { ...handle.next.body, preview_task_id: handle.taskId }, signal);
        return record(handle.kind, next.stage, taskId, handle.format, null, history);
    }

    async function cancel(handle, { signal } = {}) {
        // DELETE also succeeds on a finished task and then removes its files for good, so only a queued task is deleted.
        const status = await query(handle, { signal });
        if (status.state !== 'queued') {
            return { supported: true, canceled: false,
                detail: status.state === 'running' ? CANNOT_CANCEL_RUNNING : `任务状态为 ${status.remoteStatus}，没有执行取消` };
        }
        const response = await call('DELETE', taskPath(handle), { signal, failure: queryFailure });
        if (response.status === 409) return { supported: true, canceled: false, detail: CANNOT_CANCEL_RUNNING };
        if (!ok(response)) throw queryFailure(NAME, { response, detail: remoteMessage(response) });
        return { supported: true, canceled: true, detail: '排队中的任务已删除，Meshy 会退回创建时扣的积分' };
    }

    async function balance({ signal } = {}) {
        const response = await call('GET', '/v1/balance', { signal, failure: readFailure });
        if (!ok(response)) throw readFailure(NAME, { response, detail: remoteMessage(response) });
        const { balance: credits, ...detail } = isPlainObject(response.json) ? response.json : {};
        if (!Number.isFinite(credits)) throw model3dError('invalidResponse', NAME, { detail: '余额响应里没有 balance' });
        return { balance: credits, unit: 'credits', detail };
    }

    return { info: MESHY, submit, query, nextStage, advance, cancel, balance, pollDelayMs: () => 5000 };
}

module.exports = { MESHY, createMeshyProvider, buildMeshyTextBody, buildMeshyRefineBody, buildMeshyImageBody,
    buildMeshyMultiviewBody, meshyStatus };
