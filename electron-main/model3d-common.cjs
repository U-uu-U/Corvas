// Shared plumbing for the 3D generation providers (Meshy, Tripo, Hyper3D Rodin).
// Provider wire formats live in meshy-3d.cjs, tripo-3d.cjs and hyper3d-rodin.cjs;
// the provider-neutral entry points live in model3d-providers.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomBytes } = require('node:crypto');
const { isPublicAddress } = require('./public-media-download.cjs');

const MODEL3D_MODES = Object.freeze(['text', 'image', 'multiview']);
const MODEL3D_VIEWS = Object.freeze(['front', 'left', 'back', 'right']);
const MODEL3D_TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'canceled']);
const MODEL_FORMATS = new Set(['glb', 'gltf', 'fbx', 'obj', 'usdz', 'stl', '3mf', 'zip', 'splat', 'mtl']);
const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);

// confirmedFailure: the provider did not create a task, so nothing can be billed and resubmitting is safe.
// submissionUnknown: a task may exist and may be billed. Never resubmit automatically.
// retryable: repeating the same call later can succeed without changing the input.
const ERROR_KINDS = Object.freeze({
    invalid: { code: 'MODEL3D_INVALID_REQUEST', message: '3D 生成参数无效', confirmedFailure: true },
    unsupported: { code: 'MODEL3D_UNSUPPORTED', message: '该服务不支持这项操作', confirmedFailure: true },
    auth: { code: 'MODEL3D_AUTH_FAILED', message: 'API Key 无效或无权访问', confirmedFailure: true },
    credits: { code: 'MODEL3D_INSUFFICIENT_CREDITS', message: '账户积分不足', confirmedFailure: true },
    forbidden: { code: 'MODEL3D_FORBIDDEN', message: '账户无权使用该功能', confirmedFailure: true },
    content: { code: 'MODEL3D_CONTENT_REJECTED', message: '内容未通过审核', confirmedFailure: true },
    rejected: { code: 'MODEL3D_REQUEST_REJECTED', message: '请求被拒绝', confirmedFailure: true },
    rateLimited: { code: 'MODEL3D_RATE_LIMITED', message: '请求过于频繁或并发已满', confirmedFailure: true, retryable: true },
    network: { code: 'MODEL3D_NETWORK_UNAVAILABLE', message: '无法连接服务', confirmedFailure: true, retryable: true },
    unavailable: { code: 'MODEL3D_SERVICE_UNAVAILABLE', message: '服务暂时不可用', confirmedFailure: true, retryable: true },
    upload: { code: 'MODEL3D_UPLOAD_FAILED', message: '参考文件上传失败', confirmedFailure: true, retryable: true },
    submissionUnknown: { code: 'MODEL3D_SUBMISSION_UNKNOWN', message: '提交结果未知，任务可能已创建并扣费，不会自动重复提交',
        confirmedFailure: false, submissionUnknown: true },
    invalidResponse: { code: 'MODEL3D_INVALID_RESPONSE', message: '服务返回了无法识别的响应', confirmedFailure: false },
    statusUnavailable: { code: 'MODEL3D_STATUS_UNAVAILABLE', message: '任务状态暂时无法查询，任务仍可能在运行', confirmedFailure: false },
    taskNotFound: { code: 'MODEL3D_TASK_NOT_FOUND', message: '任务不存在或已过期', confirmedFailure: false },
    taskFailed: { code: 'MODEL3D_TASK_FAILED', message: '3D 生成任务失败', confirmedFailure: true },
    taskCanceled: { code: 'MODEL3D_TASK_CANCELED', message: '3D 生成任务已取消', confirmedFailure: true },
    waitTimeout: { code: 'MODEL3D_WAIT_TIMEOUT', message: '等待任务结果超时，任务仍可能在运行', confirmedFailure: false },
    download: { code: 'MODEL3D_DOWNLOAD_FAILED', message: '模型文件下载失败', confirmedFailure: false, retryable: true }
});

function redact(text, secrets = []) {
    let value = String(text ?? '');
    for (const secret of secrets) if (secret) value = value.split(String(secret)).join('***');
    return value.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function model3dError(kind, provider, extras = {}) {
    const entry = ERROR_KINDS[kind] || ERROR_KINDS.invalidResponse;
    const { detail, ...rest } = extras;
    const label = provider ? `${provider}：` : '';
    const error = new Error(`${label}${entry.message}${detail ? `（${redact(detail)}）` : ''}`);
    return Object.assign(error, { code: entry.code, kind, provider: provider || null,
        confirmedFailure: Boolean(entry.confirmedFailure), submissionUnknown: Boolean(entry.submissionUnknown),
        retryable: Boolean(entry.retryable) }, rest);
}

function abortError() {
    return Object.assign(new Error('3D 生成已中断'), { name: 'AbortError', code: 'GENERATION_CANCELED' });
}

const isAbortError = error => error?.name === 'AbortError' || error?.code === 'GENERATION_CANCELED';

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function waitFor(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(abortError()); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function assertApiKey(apiKey, provider) {
    const key = String(apiKey ?? '').trim();
    // Printable ASCII only. A space or control character could break out of the Authorization header, and
    // fetch refuses any other character before sending, which would look like an unknown submission.
    if (!/^[\x21-\x7e]+$/.test(key)) throw model3dError('auth', provider, { detail: '未填写或格式不正确' });
    return key;
}

function resolveBaseUrl(input, fallback, provider) {
    let url;
    try { url = new URL(String(input || fallback).trim()); } catch { /* reported below */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw model3dError('invalid', provider, { detail: 'API 地址必须是不带账号和参数的 HTTPS 地址' });
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function headerValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return String(headers.get(name) ?? '');
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? String(headers[key] ?? '') : '';
}

// Retry-After is either seconds or an HTTP date. Capped so a bad header cannot stall a job for hours.
function retryAfterMs(headers, now = Date.now()) {
    const raw = headerValue(headers, 'retry-after').trim();
    if (!raw) return null;
    const seconds = Number(raw);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
    return Number.isFinite(ms) ? Math.min(Math.max(0, Math.round(ms)), 5 * 60 * 1000) : null;
}

// True only when the request provably never reached the provider, so no task can exist. The list is kept
// short on purpose: a wrong "never sent" leads to a second billed task, a wrong "unknown" only to a manual check.
// Timeouts and unreachable-network errors are left out because a socket can report them after the request went out.
function requestNeverSent(error) {
    const cause = error?.cause || error;
    const code = String(cause?.code || '');
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true;
    if (['ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return cause.syscall === 'connect';
    return /ERR_(?:CONNECTION_REFUSED|NAME_NOT_RESOLVED|PROXY_CONNECTION_FAILED)\b/.test(String(error?.message || ''));
}

function resolveFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof fetchImpl?.fetch === 'function') return fetchImpl.fetch.bind(fetchImpl);
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    throw new Error('3D 生成缺少网络请求实现');
}

// One HTTP exchange. Resolves with the parsed response for every HTTP status; rejects with
// { transport: true, timedOut, neverSent } when no complete response arrived, or with an AbortError
// whose `dispatched` says whether the request had already been handed to fetch.
async function httpRequest(fetchImpl, { method = 'GET', url, headers = {}, body, timeoutMs = 30000, signal } = {}) {
    // Resolved outside the try: a missing implementation is a setup error, not a request with an unknown outcome.
    const fetcher = resolveFetch(fetchImpl);
    if (signal?.aborted) throw Object.assign(abortError(), { dispatched: false });
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        // redirect: 'error' keeps the Authorization header from following a redirect to another host.
        const response = await fetcher(url, { method, headers, body, redirect: 'error', signal: controller.signal });
        const text = await response.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* Non-JSON bodies come from gateways; callers use status. */ }
        return { status: Number(response.status) || 0, headers: response.headers, text, json };
    } catch (error) {
        if (signal?.aborted) throw Object.assign(abortError(), { dispatched: true });
        throw Object.assign(new Error(timedOut ? '请求超时' : String(error?.message || error)),
            { transport: true, timedOut, neverSent: !timedOut && requestNeverSent(error) });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

// Maps a failed create/submit exchange. `response` is an httpRequest result, `transport` a rejected one.
// Providers pass `kind` when their documentation gives a status or code a more specific meaning.
function submitFailure(provider, { response, transport, kind, detail, remoteCode } = {}) {
    if (transport) {
        // An abort stays an abort. Unless it is known to have come before the request went out,
        // the task may exist, so it carries the same warning as any other unknown outcome.
        if (isAbortError(transport)) return Object.assign(transport, { submissionUnknown: transport.dispatched !== false });
        return model3dError(transport.neverSent ? 'network' : 'submissionUnknown', provider, { detail: transport.message });
    }
    const status = Number(response?.status) || 0;
    // 408 and 425 are 4xx, but the server may already have started on the request.
    const definite = status >= 400 && status < 500 && status !== 408 && status !== 425;
    const resolved = kind || (status === 401 ? 'auth' : status === 402 ? 'credits' : status === 403 ? 'forbidden'
        : status === 429 ? 'rateLimited' : definite ? 'rejected' : 'submissionUnknown');
    return model3dError(resolved, provider, { detail: detail || `HTTP ${status}`, status,
        remoteCode: remoteCode ?? null, retryAfterMs: retryAfterMs(response?.headers) });
}

// Maps a failed status/query exchange. `transient` tells the polling loop to keep the task and try again.
function queryFailure(provider, { response, transport, detail, remoteCode } = {}) {
    if (transport) {
        if (isAbortError(transport)) return transport;
        return model3dError('statusUnavailable', provider, { detail: transport.message, transient: true });
    }
    const status = Number(response?.status) || 0;
    // The task already exists, so a rejected key here is not a confirmed task failure.
    if (status === 401 || status === 403) {
        return model3dError('auth', provider, { detail: detail || `HTTP ${status}`, status, remoteCode, confirmedFailure: false });
    }
    if (status === 404) return model3dError('taskNotFound', provider, { detail: detail || `HTTP ${status}`, status, remoteCode });
    return model3dError('statusUnavailable', provider, { detail: detail || `HTTP ${status}`, status, remoteCode,
        transient: [408, 425, 429].includes(status) || status >= 500, retryAfterMs: retryAfterMs(response?.headers) });
}

// Maps a failed read that is not about a task, such as the balance. Nothing is created, so repeating it is safe.
function readFailure(provider, { response, transport, detail, remoteCode } = {}) {
    if (transport) return isAbortError(transport) ? transport : model3dError('network', provider, { detail: transport.message });
    const status = Number(response?.status) || 0;
    const kind = status === 401 ? 'auth' : status === 403 ? 'forbidden' : status === 429 ? 'rateLimited'
        : status >= 400 && status < 500 ? 'rejected' : 'unavailable';
    return model3dError(kind, provider, { detail: detail || `HTTP ${status}`, status, remoteCode: remoteCode ?? null,
        retryAfterMs: retryAfterMs(response?.headers) });
}

function sniffImage(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { mime: 'image/png', ext: 'png' };
    }
    if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
        return { mime: 'image/webp', ext: 'webp' };
    }
    return null;
}

function publicHttpUrl(value, provider, label) {
    let url;
    try { url = new URL(String(value)); } catch { /* reported below */ }
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw model3dError('invalid', provider, { detail: `${label}必须是公网 HTTP(S) 地址` });
    }
    return url.toString();
}

// Reads one reference image. Returns { url } for a remote URL the provider fetches itself, or
// { buffer, mime, ext, name } for local bytes. The type comes from the file's magic bytes, not its extension.
// Callers own path authorization (mediaAccess); this function reads whatever path it is given.
async function loadModel3dImage(source, { provider, formats = ['image/jpeg', 'image/png', 'image/webp'], maxBytes, allowUrl = true } = {}) {
    const input = typeof source === 'string'
        ? (/^https?:\/\//i.test(source) ? { url: source } : /^data:/i.test(source) ? { dataUri: source } : { path: source })
        : (source || {});
    if (input.url) {
        if (!allowUrl) throw model3dError('invalid', provider, { detail: '参考图需要本地文件，不支持网络地址' });
        return { url: publicHttpUrl(input.url, provider, '参考图') };
    }
    let buffer;
    let name = String(input.name || 'image');
    if (input.dataUri) {
        const match = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(input.dataUri));
        if (!match) throw model3dError('invalid', provider, { detail: '参考图 data URI 不是 base64 图片' });
        buffer = Buffer.from(match[1], 'base64');
    } else if (input.buffer) {
        buffer = Buffer.from(input.buffer);
    } else if (input.path) {
        const filePath = path.resolve(String(input.path));
        let stats;
        try { stats = await fs.promises.stat(filePath); } catch { /* reported below */ }
        if (!stats?.isFile()) throw model3dError('invalid', provider, { detail: '参考图文件不存在' });
        if (maxBytes && stats.size > maxBytes) throw model3dError('invalid', provider, { detail: `参考图超过 ${Math.floor(maxBytes / 1048576)} MB` });
        buffer = await fs.promises.readFile(filePath);
        name = path.basename(filePath);
    } else {
        throw model3dError('invalid', provider, { detail: '缺少参考图' });
    }
    if (!buffer.length) throw model3dError('invalid', provider, { detail: '参考图为空' });
    if (maxBytes && buffer.length > maxBytes) throw model3dError('invalid', provider, { detail: `参考图超过 ${Math.floor(maxBytes / 1048576)} MB` });
    const type = sniffImage(buffer);
    if (!type || !formats.includes(type.mime)) {
        throw model3dError('invalid', provider, { detail: `参考图格式不受支持，可用：${formats.map(mime => mime.slice(6)).join('、')}` });
    }
    return { buffer, mime: type.mime, ext: type.ext, name: `${path.parse(name).name || 'image'}.${type.ext}` };
}

const toDataUri = image => `data:${image.mime};base64,${image.buffer.toString('base64')}`;

// multipart/form-data built by hand so the exact bytes are the same under Node fetch and Electron net.fetch.
// parts: { name, value } for text fields, { name, filename, contentType, data } for files.
function encodeMultipart(parts) {
    const boundary = `----corvas${randomBytes(12).toString('hex')}`;
    const quote = value => String(value).replace(/[\r\n]/g, ' ').replace(/"/g, '%22');
    const chunks = [];
    for (const part of parts) {
        const file = part.data !== undefined;
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(part.name)}"`
            + (file ? `; filename="${quote(part.filename || 'file')}"\r\nContent-Type: ${part.contentType || 'application/octet-stream'}` : '')
            + '\r\n\r\n'));
        chunks.push(file ? Buffer.from(part.data) : Buffer.from(String(part.value)));
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function extensionOf(value) {
    let pathname = String(value || '');
    try { pathname = new URL(pathname).pathname; } catch { /* Plain file names are used as they are. */ }
    const match = /\.([a-z0-9]{2,5})$/i.exec(pathname);
    return match ? match[1].toLowerCase() : '';
}

// Builds one downloadable output entry. `format` falls back to the extension of the name or URL.
function model3dOutput({ url, role, format, name } = {}) {
    if (!url) return null;
    const ext = String(format || extensionOf(name) || extensionOf(url) || '').toLowerCase();
    const resolvedRole = role || (MODEL_FORMATS.has(ext) ? 'model' : IMAGE_FORMATS.has(ext) ? 'image' : 'file');
    return { role: resolvedRole, format: ext || null, url: String(url), name: name ? String(name) : null };
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Validates the provider-neutral request and fills defaults. `limits` comes from the provider:
// { promptMax, multiview: [min, max], formats: [...], targetFaces: [min, max] }.
function normalizeModel3dRequest(request = {}, limits = {}, provider) {
    const fail = detail => model3dError('invalid', provider, { detail });
    const mode = String(request.mode || '').trim();
    if (!MODEL3D_MODES.includes(mode)) throw fail('生成方式必须是 text、image 或 multiview');
    const prompt = String(request.prompt ?? '').trim();
    if (limits.promptMax && prompt.length > limits.promptMax) throw fail(`提示词最多 ${limits.promptMax} 个字符`);
    const rawImages = Array.isArray(request.images) ? request.images : request.image != null ? [request.image] : [];
    if (mode === 'text') {
        if (!prompt) throw fail('文生 3D 需要提示词');
        if (rawImages.length) throw fail('文生 3D 不接受参考图，请改用 image 或 multiview');
    } else if (mode === 'image') {
        if (rawImages.length !== 1) throw fail('图生 3D 需要 1 张参考图');
    } else {
        const [min, max] = limits.multiview || [2, 4];
        if (rawImages.length < min || rawImages.length > max) throw fail(`多视图需要 ${min} 到 ${max} 张参考图`);
    }
    const images = rawImages.map(entry => (isPlainObject(entry) && entry.source !== undefined
        ? { source: entry.source, view: entry.view } : { source: entry, view: isPlainObject(entry) ? entry.view : undefined }));
    if (mode === 'multiview') {
        const used = new Set();
        for (const image of images) {
            if (image.view === undefined || image.view === null || image.view === '') continue;
            if (!MODEL3D_VIEWS.includes(image.view) || used.has(image.view)) throw fail('多视图的视角必须是 front、left、back、right 且不重复');
            used.add(image.view);
        }
        for (const image of images) {
            if (image.view) continue;
            image.view = MODEL3D_VIEWS.find(view => !used.has(view));
            if (!image.view) throw fail('多视图最多 4 个视角');
            used.add(image.view);
        }
        if (!used.has('front')) throw fail('多视图必须包含 front（正面）');
        images.sort((a, b) => MODEL3D_VIEWS.indexOf(a.view) - MODEL3D_VIEWS.indexOf(b.view));
    }
    const texture = request.texture !== false;
    const pbr = request.pbr === undefined || request.pbr === null ? texture : Boolean(request.pbr);
    if (pbr && !texture) throw fail('PBR 材质需要同时生成贴图');
    const topology = request.topology ? String(request.topology) : null;
    if (topology && !['triangle', 'quad'].includes(topology)) throw fail('拓扑必须是 triangle 或 quad');
    let targetFaces = null;
    if (request.targetFaces !== undefined && request.targetFaces !== null) {
        targetFaces = Number(request.targetFaces);
        const [min, max] = limits.targetFaces || [1, Number.MAX_SAFE_INTEGER];
        if (!Number.isInteger(targetFaces) || targetFaces < min || targetFaces > max) throw fail(`目标面数必须是 ${min} 到 ${max} 的整数`);
    }
    const format = String(request.format || 'glb').toLowerCase();
    if (limits.formats && !limits.formats.includes(format)) throw fail(`输出格式必须是 ${limits.formats.join('、')} 之一`);
    let seed = null;
    if (request.seed !== undefined && request.seed !== null) {
        seed = Number(request.seed);
        const max = limits.seedMax ?? Number.MAX_SAFE_INTEGER;
        if (!Number.isInteger(seed) || seed < 0 || seed > max) throw fail(`随机种子必须是 0 到 ${max} 的整数`);
    }
    const model = request.model ? String(request.model).trim() : null;
    if (model && !/^[\w.-]{1,64}$/.test(model)) throw fail('模型标识格式无效');
    for (const [key, value] of [['providerOptions', request.providerOptions], ['stageOptions', request.stageOptions]]) {
        if (value !== undefined && value !== null && !isPlainObject(value)) throw fail(`${key} 必须是对象`);
    }
    return { mode, prompt, images, texture, pbr, topology, targetFaces, format, seed, model,
        providerOptions: { ...(request.providerOptions || {}) }, stageOptions: { ...(request.stageOptions || {}) } };
}

// Polls until the task reaches a terminal state. Query failures marked `transient` do not fail the task:
// a failed status read says nothing about the task itself, and resubmitting would bill a second time.
// `initialDelayMs` holds back the first query of a task that was just created: a provider may not know it yet.
async function waitForModel3dTask({ provider, handle, query, delayMs, maxWaitMs = 20 * 60 * 1000, signal, onProgress,
    wait = waitFor, now = Date.now, maxQueryFailures = 5, initialDelayMs = 0 } = {}) {
    const startedAt = now();
    if (initialDelayMs > 0) await wait(initialDelayMs, signal);
    let failures = 0;
    let last = null;
    for (let attempt = 0; ; attempt += 1) {
        throwIfAborted(signal);
        let pause = null;
        try {
            const status = await query(handle, { signal });
            failures = 0;
            last = status;
            onProgress?.({ provider, handle, status });
            if (MODEL3D_TERMINAL_STATES.includes(status.state)) return status;
            pause = status.retryAfterMs;
        } catch (error) {
            if (isAbortError(error)) throw error;
            failures += 1;
            if (!error?.transient || failures > maxQueryFailures) throw Object.assign(error, { handle });
            pause = error.retryAfterMs;
            onProgress?.({ provider, handle, status: last, recovering: true, queryFailures: failures });
        }
        if (now() - startedAt >= maxWaitMs) throw model3dError('waitTimeout', provider, { handle, lastStatus: last });
        // Never below one second, whatever Retry-After says: status queries count against the rate limit.
        await wait(Math.max(1000, pause ?? delayMs(attempt, last)), signal);
    }
}

function safeFileStem(value) {
    const stem = String(value || 'model').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80);
    return stem && !/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? stem : 'model';
}

// Downloads one output to `dir` without sending the API key: result URLs are pre-signed.
// Writes to a temporary file first so a broken transfer never leaves a truncated model behind.
async function downloadModel3dOutput(output, { dir, baseName, fetchImpl, signal, provider, maxBytes = 2 * 1024 ** 3,
    timeoutMs = 15 * 60 * 1000 } = {}) {
    const fail = detail => model3dError('download', provider, { detail });
    let url;
    try { url = new URL(String(output?.url || '')); } catch { /* reported below */ }
    const host = url ? url.hostname.replace(/^\[|\]$/g, '') : '';
    if (!url || url.protocol !== 'https:' || url.username || url.password
        || /^(?:localhost|.*\.(?:localhost|local|internal))\.?$/i.test(host) || (isIP(host) && !isPublicAddress(host))) {
        throw fail('下载地址不是公网 HTTPS 地址');
    }
    if (!dir) throw fail('缺少保存目录');
    throwIfAborted(signal);
    await fs.promises.mkdir(dir, { recursive: true });
    const ext = String(output.format || extensionOf(output.name) || extensionOf(url.href) || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const stem = safeFileStem(baseName || path.parse(String(output.name || '')).name);
    const temporary = path.join(dir, `.${stem}.${randomBytes(6).toString('hex')}.part`);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const response = await resolveFetch(fetchImpl)(url.href, { method: 'GET', redirect: 'follow', signal: controller.signal });
        if (!response.ok) throw fail(`HTTP ${response.status}`);
        let bytes = 0;
        const counter = new Transform({ transform(chunk, _encoding, done) {
            bytes += chunk.length;
            done(bytes > maxBytes ? fail('文件超过大小上限') : null, chunk);
        } });
        const source = response.body ? Readable.fromWeb(response.body) : Readable.from([Buffer.from(await response.arrayBuffer())]);
        await pipeline(source, counter, fs.createWriteStream(temporary, { flags: 'wx' }));
        if (!bytes) throw fail('下载到的文件为空');
        let target = path.join(dir, `${stem}.${ext}`);
        for (let index = 2; fs.existsSync(target); index += 1) target = path.join(dir, `${stem}-${index}.${ext}`);
        await fs.promises.rename(temporary, target);
        return { path: target, bytes, format: ext, role: output.role || 'model' };
    } catch (error) {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
        if (signal?.aborted) throw abortError();
        if (error?.code === 'MODEL3D_DOWNLOAD_FAILED') throw error;
        throw fail(timedOut ? '下载超时' : String(error?.message || error));
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

module.exports = { MODEL3D_MODES, MODEL3D_VIEWS, MODEL3D_TERMINAL_STATES, ERROR_KINDS, model3dError, abortError, isAbortError,
    throwIfAborted, waitFor, assertApiKey, resolveBaseUrl, headerValue, retryAfterMs, requestNeverSent, httpRequest,
    submitFailure, queryFailure, readFailure, sniffImage, loadModel3dImage, toDataUri, encodeMultipart, extensionOf, model3dOutput,
    isPlainObject, normalizeModel3dRequest, waitForModel3dTask, safeFileStem, downloadModel3dOutput, redact };
