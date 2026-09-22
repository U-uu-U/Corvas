'use strict';

const { writeGeneratedMedia } = require('./generated-media-names.cjs');

const SHANHAI_HOST = 'shanhai.vnshu.cn';
const SHANHAI_BASE_PATH = '/api/v1';
const SHANHAI_MODELS = new Set([
    'oc-model-qbdmeb',
    'oc-model-1iq31f',
    'oc-model-bkb50q',
    'oc-model-c6ws7e'
]);
const MODEL_PATTERN = /^(?:(?:shanhai[-_])?(?:seedance|dola)[-_][a-z0-9._-]+)$/i;
const MEDIA_LIMITS = { image: 30, video: 10, audio: 10 };
const ALLOWED_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive']);
const ALLOWED_RESOLUTIONS = new Set(['480p', '720p', '1080p']);
const TERMINAL_SUCCESS = new Set(['succeeded', 'success', 'completed', 'done']);
const TERMINAL_FAILURE = new Set(['failed', 'error', 'cancelled', 'canceled', 'rejected']);
const TRANSIENT_HTTP_STATUSES = new Set([404, 408, 425, 429, 500, 502, 503, 504]);
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

function isShanhaiEndpoint(endpoint) {
    try {
        const url = new URL(String(endpoint || '').trim());
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        return url.protocol === 'https:' && !url.username && !url.password
            && url.hostname.toLowerCase() === SHANHAI_HOST
            && (pathname === '/' || pathname === '/api' || pathname === SHANHAI_BASE_PATH
                || pathname === `${SHANHAI_BASE_PATH}/generations` || pathname === `${SHANHAI_BASE_PATH}/tasks`);
    } catch (_) {
        return false;
    }
}

function shanhaiEndpoint(endpoint) {
    const raw = String(endpoint || '').trim();
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error('Shanhai API 地址无效'); }
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('Shanhai API 地址必须使用 HTTPS');
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (url.hostname.toLowerCase() !== SHANHAI_HOST
        || !['/', '/api', SHANHAI_BASE_PATH, `${SHANHAI_BASE_PATH}/generations`, `${SHANHAI_BASE_PATH}/tasks`].includes(pathname)) {
        throw new Error('Shanhai API 地址应为 https://shanhai.vnshu.cn/api/v1');
    }
    url.pathname = SHANHAI_BASE_PATH;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function isShanhaiModel(model) {
    const value = String(model || '').trim();
    return SHANHAI_MODELS.has(value.toLowerCase()) || MODEL_PATTERN.test(value);
}

function modelRules(model) {
    const id = String(model || '').trim().toLowerCase();
    if (id === 'oc-model-qbdmeb') return { durations: new Set([5, 10, 15]), defaultDuration: 15, imageLimit: 10, resolution: new Set(['720p']) };
    if (id === 'oc-model-1iq31f') return { minDuration: 5, maxDuration: 15, defaultDuration: 10, imageLimit: 9, resolution: new Set(['480p', '720p', '1080p']) };
    if (id === 'oc-model-bkb50q' || id === 'oc-model-c6ws7e') {
        return { minDuration: 4, maxDuration: 15, defaultDuration: 10, totalReferences: 0, resolution: new Set(['720p']) };
    }
    return { minDuration: 4, maxDuration: 30, defaultDuration: 4, resolution: ALLOWED_RESOLUTIONS };
}

function shanhaiReferenceLimits(model) {
    const rules = modelRules(model);
    if (rules.totalReferences === 0) return { image: 0, video: 0, audio: 0 };
    return { image: rules.imageLimit ?? 10, video: 0, audio: 0 };
}

function mediaUrlList(values, type) {
    if (values == null) return [];
    if (!Array.isArray(values)) throw new Error(`Shanhai ${type}参考素材必须是数组`);
    if (values.length > MEDIA_LIMITS[type]) throw new Error(`Shanhai 最多支持 ${MEDIA_LIMITS[type]} 个${type}参考素材`);
    return values.map(value => {
        const candidate = typeof value === 'string' ? value : value?.url;
        let url;
        try { url = new URL(String(candidate || '').trim()); } catch (_) { /* Keep the error generic. */ }
        if (!url || url.protocol !== 'https:' || url.username || url.password) {
            throw new Error(`Shanhai ${type}参考素材必须使用 HTTPS URL`);
        }
        return url.toString();
    });
}

function buildShanhaiGenerationBody({ model, prompt, duration, ratio = '16:9', aspectRatio,
    resolution = '720p', imageUrls = [], videoUrls = [], audioUrls = [] } = {}) {
    const modelValue = String(model || '').trim();
    if (!modelValue) throw new Error('Shanhai 模型不能为空');
    const promptValue = String(prompt || '').trim();
    if (!promptValue) throw new Error('Shanhai 提示词不能为空');
    const rules = modelRules(modelValue);
    const defaultDuration = rules.defaultDuration ?? (rules.durations ? Math.min(...rules.durations) : rules.minDuration);
    const durationValue = duration === undefined || duration === null || duration === ''
        ? defaultDuration : Number(duration);
    if (!Number.isInteger(durationValue)
        || (rules.durations ? !rules.durations.has(durationValue) : durationValue < rules.minDuration || durationValue > rules.maxDuration)) {
        throw new Error('Shanhai 视频时长不符合当前模型限制');
    }
    const requestedRatio = String(aspectRatio ?? ratio ?? '16:9').trim();
    const ratioValue = requestedRatio.toLowerCase() === 'adaptive' ? '16:9' : requestedRatio;
    if (!ALLOWED_RATIOS.has(ratioValue)) throw new Error('Shanhai 画幅比例不受支持');
    const resolutionValue = String(resolution || '720p').trim().toLowerCase();
    if (!rules.resolution.has(resolutionValue)) throw new Error('Shanhai 分辨率不符合当前模型限制');
    const images = mediaUrlList(imageUrls, '图片');
    const videos = mediaUrlList(videoUrls, '视频');
    const audios = mediaUrlList(audioUrls, '音频');
    if (rules.imageLimit != null && images.length > rules.imageLimit) {
        throw new Error(`Shanhai 当前模型最多支持 ${rules.imageLimit} 张参考图片`);
    }
    if (rules.totalReferences === 0 && images.length + videos.length + audios.length > 0) {
        throw new Error('Shanhai 当前模型不支持参考素材');
    }
    if (images.length + videos.length + audios.length > 10) {
        throw new Error('Shanhai 最多支持 10 个参考素材');
    }
    const inputs = [
        ...images.map(url => ({ type: 'image', url })),
        ...videos.map(url => ({ type: 'video', url })),
        ...audios.map(url => ({ type: 'audio', url }))
    ];
    return {
        model: modelValue,
        prompt: promptValue,
        media_type: 'video',
        ...(inputs.length ? { inputs } : {}),
        options: { aspect_ratio: ratioValue, resolution: resolutionValue, duration: String(durationValue) }
    };
}

function abortError() {
    const error = new Error('生成任务已中断');
    error.name = 'AbortError';
    error.code = 'GENERATION_CANCELED';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function safeError(message, code, extras = {}) {
    return Object.assign(new Error(message), { code, ...extras });
}

function unknownSubmission(error, requestId) {
    if (error?.name === 'AbortError' || error?.code === 'GENERATION_CANCELED') throw error;
    return safeError('山海提交结果未知，请稍后从任务记录恢复，不会自动重复提交', 'SHANHAI_SUBMISSION_UNKNOWN', {
        submissionUnknown: true, confirmedFailure: false, requestId
    });
}

async function responseText(response) {
    try {
        if (typeof response?.text === 'function') return await response.text();
        if (typeof response?.json === 'function') return JSON.stringify(await response.json());
    } catch (_) { /* Treat an unreadable response as an uncertain submission or poll failure. */ }
    return '';
}

function parseJson(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
}

function responseOk(response) {
    if (typeof response?.ok === 'boolean') return response.ok;
    const status = Number(response?.status);
    return Number.isFinite(status) && status >= 200 && status < 300;
}

function payloadData(payload) {
    return payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? payload.data : payload || {};
}

function taskIdFromPayload(payload) {
    const data = payloadData(payload);
    const value = payload?.id ?? payload?.task_id ?? data.id ?? data.task_id;
    return value == null ? '' : String(value).trim();
}

function statusFromPayload(payload) {
    const data = payloadData(payload);
    return String(payload?.status ?? data.status ?? '').trim().toLowerCase();
}

function outputUrlFromPayload(payload) {
    const data = payloadData(payload);
    const value = payload?.output?.url ?? data.output?.url ?? payload?.url ?? data.url;
    return typeof value === 'string' ? value.trim() : '';
}

function safeOutputUrl(value) {
    let url;
    try { url = new URL(String(value || '')); } catch (_) { throw new Error('山海任务返回的产物地址无效'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('山海任务返回的产物地址必须使用 HTTPS');
    return url.toString();
}

async function fetchShanhaiOutput(fetcher, outputUrl, key, signal) {
    let currentUrl = outputUrl;
    let authorization = true;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
        const headers = { Accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.1' };
        if (authorization && new URL(currentUrl).hostname.toLowerCase() === SHANHAI_HOST) headers.Authorization = `Bearer ${key}`;
        const response = await fetcher(currentUrl, { method: 'GET', headers, redirect: 'manual', signal });
        const status = Number(response?.status);
        if (![301, 302, 303, 307, 308].includes(status)) return { response, url: currentUrl };
        const location = response.headers?.get?.('location');
        if (!location || redirects >= 5) throw new Error('山海视频产物重定向次数过多');
        const nextUrl = safeOutputUrl(new URL(location, currentUrl).toString());
        authorization = new URL(currentUrl).origin === new URL(nextUrl).origin;
        currentUrl = nextUrl;
    }
    throw new Error('山海视频产物重定向次数过多');
}

function waitFor(ms, signal) {
    throwIfAborted(signal);
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function fetchFunction(fetchImpl, net) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof fetchImpl?.fetch === 'function') return fetchImpl.fetch.bind(fetchImpl);
    if (typeof net?.fetch === 'function') return net.fetch.bind(net);
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    throw new Error('Shanhai 缺少网络请求实现');
}

function pollingValues({ maxPolls = 120, maxRetries = 3, pollIntervalMs = 5000 } = {}) {
    return {
        pollLimit: Number.isInteger(Number(maxPolls)) && Number(maxPolls) > 0 ? Number(maxPolls) : 120,
        retryLimit: Number.isInteger(Number(maxRetries)) && Number(maxRetries) >= 0 ? Number(maxRetries) : 3,
        interval: Number.isFinite(Number(pollIntervalMs)) && Number(pollIntervalMs) >= 0 ? Number(pollIntervalMs) : 5000
    };
}

async function pollShanhaiTask({ base, key, taskId, fetcher, signal, onProgress, maxPolls, maxRetries, pollIntervalMs }) {
    const { pollLimit, retryLimit, interval } = pollingValues({ maxPolls, maxRetries, pollIntervalMs });
    let retries = 0;
    let outputUrl = '';
    let finalPayload = {};
    for (let attempt = 0; attempt < pollLimit; attempt += 1) {
        throwIfAborted(signal);
        if (attempt > 0) await waitFor(interval, signal);
        let response;
        let text;
        try {
            response = await fetcher(`${base}/tasks/${encodeURIComponent(taskId)}`, { method: 'GET', headers: {
                Authorization: `Bearer ${key}`, Accept: 'application/json' }, redirect: 'error', signal });
            text = await responseText(response);
        } catch (error) {
            throwIfAborted(signal);
            if (retries++ < retryLimit) {
                onProgress?.({ stage: 'recovering', retryCount: retries, remoteStatus: 'network_error' });
                continue;
            }
            throw safeError('山海任务状态暂时无法查询，请稍后恢复任务', 'SHANHAI_STATUS_UNAVAILABLE', { confirmedFailure: false, taskId });
        }
        throwIfAborted(signal);
        if (!responseOk(response)) {
            if (TRANSIENT_HTTP_STATUSES.has(Number(response?.status)) && retries++ < retryLimit) {
                onProgress?.({ stage: 'recovering', retryCount: retries, remoteStatus: `HTTP ${response.status}` });
                continue;
            }
            throw safeError('山海任务查询失败，请稍后重试', 'SHANHAI_HTTP_ERROR', {
                status: Number(response?.status) || 0, confirmedFailure: false, taskId
            });
        }
        const payload = parseJson(text);
        if (!payload) {
            if (retries++ < retryLimit) continue;
            throw safeError('山海任务返回了无效状态', 'SHANHAI_INVALID_RESPONSE', { confirmedFailure: false, taskId });
        }
        retries = 0;
        finalPayload = payload;
        const status = statusFromPayload(payload);
        outputUrl = outputUrlFromPayload(payload);
        const progressStage = TERMINAL_SUCCESS.has(status) ? 'download'
            : ['running', 'processing', 'in_progress'].includes(status) ? 'processing' : 'queued';
        onProgress?.({ stage: progressStage, remoteStatus: status || null,
            progress: payload?.progress ?? payloadData(payload)?.progress ?? undefined });
        if (TERMINAL_FAILURE.has(status)) {
            throw safeError('山海视频任务失败', 'SHANHAI_TASK_FAILED', { confirmedFailure: true, taskId });
        }
        if (outputUrl && (TERMINAL_SUCCESS.has(status) || !status)) break;
        if (TERMINAL_SUCCESS.has(status) && !outputUrl && attempt + 1 >= pollLimit) {
            throw safeError('山海任务已完成但未返回产物地址', 'SHANHAI_INVALID_RESPONSE', { confirmedFailure: false, taskId });
        }
    }
    if (!outputUrl) throw safeError('山海视频生成超时，请稍后从任务记录恢复', 'SHANHAI_POLL_TIMEOUT', { confirmedFailure: false, taskId });
    return { payload: finalPayload, url: safeOutputUrl(outputUrl), taskId };
}

async function downloadShanhaiVideo({ url, taskId, key, fetcher, signal, targetDir, prompt, namingPrompt,
    writeMedia, onProgress, onDownloaded, options }) {
    const outputUrl = safeOutputUrl(url);
    throwIfAborted(signal);
    onProgress?.({ stage: 'download', progress: 100, remoteStatus: 'succeeded' });
    let response;
    try {
        ({ response } = await fetchShanhaiOutput(fetcher, outputUrl, key, signal));
    } catch (error) {
        throwIfAborted(signal);
        throw safeError('山海视频产物下载失败，请稍后重试', 'SHANHAI_DOWNLOAD_FAILED', { confirmedFailure: false, taskId });
    }
    throwIfAborted(signal);
    if (!responseOk(response)) throw safeError('山海视频产物下载失败，请稍后重试', 'SHANHAI_DOWNLOAD_FAILED', {
        status: Number(response?.status) || 0, confirmedFailure: false, taskId
    });
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
        throw safeError('山海视频产物超过下载大小限制', 'SHANHAI_DOWNLOAD_FAILED', { confirmedFailure: false, taskId });
    }
    let buffer;
    try { buffer = Buffer.from(await response.arrayBuffer()); }
    catch (_) { throw safeError('山海视频产物下载失败，请稍后重试', 'SHANHAI_DOWNLOAD_FAILED', { confirmedFailure: false, taskId }); }
    if (buffer.length > MAX_DOWNLOAD_BYTES) throw safeError('山海视频产物超过下载大小限制', 'SHANHAI_DOWNLOAD_FAILED', { confirmedFailure: false, taskId });
    if (!buffer.length) throw safeError('山海返回了空视频产物', 'SHANHAI_DOWNLOAD_FAILED', { confirmedFailure: false, taskId });
    throwIfAborted(signal);
    const promptForName = typeof namingPrompt === 'function' ? namingPrompt(options, prompt) : String(namingPrompt || prompt || '');
    const writer = typeof writeMedia === 'function' ? writeMedia : writeGeneratedMedia;
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    const extension = contentType.includes('webm') ? '.webm' : contentType.includes('quicktime') ? '.mov' : '.mp4';
    const filePath = await writer(buffer, { targetDir, prompt: promptForName, mediaType: 'video', extension });
    throwIfAborted(signal);
    onDownloaded?.({ filePath, filePaths: [filePath], taskId, mediaType: 'video', video: { url: outputUrl }, targetDir });
    onProgress?.({ stage: 'completed', progress: 100, remoteStatus: 'succeeded' });
    return { success: true, provider: 'shanhai-video', taskId, url: outputUrl, filePath,
        width: Number(options?.width) || undefined, height: Number(options?.height) || undefined };
}

function resolveShanhaiOptions(options = {}) {
    const config = options.providerConfig && typeof options.providerConfig === 'object' ? options.providerConfig : {};
    return {
        ...options,
        config,
        endpoint: options.endpoint || options.generationEndpoint || config.endpoint,
        apiKey: String(options.apiKey || config.apiKey || '').trim(),
        model: options.model || config.model
    };
}

async function generateShanhaiVideo(options = {}) {
    const resolved = resolveShanhaiOptions(options);
    const { endpoint, apiKey, model, prompt, duration, ratio = '16:9', aspectRatio,
        resolution = '720p', imageUrls = [], videoUrls = [], audioUrls = [], signal, fetchImpl, net,
        onProgress, onTaskSubmitted, clientTaskId } = resolved;
    const base = shanhaiEndpoint(endpoint);
    if (!apiKey) throw new Error('Shanhai API Key 不能为空');
    const body = buildShanhaiGenerationBody({ model, prompt, duration, ratio, aspectRatio, resolution,
        imageUrls, videoUrls, audioUrls });
    const fetcher = fetchFunction(fetchImpl, net);
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    throwIfAborted(signal);
    onProgress?.({ stage: 'submit' });
    let response;
    try {
        response = await fetcher(`${base}/generations`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal });
    } catch (error) { throw unknownSubmission(error, clientTaskId); }
    throwIfAborted(signal);
    const payload = parseJson(await responseText(response));
    if (!responseOk(response)) throw safeError('山海视频提交失败，请检查模型或参数', 'SHANHAI_HTTP_ERROR', {
        status: Number(response?.status) || 0, confirmedFailure: true, submissionUnknown: false
    });
    if (!payload) throw unknownSubmission(new Error('invalid JSON'), clientTaskId);
    const taskId = taskIdFromPayload(payload);
    const initialUrl = outputUrlFromPayload(payload);
    if (!taskId && !initialUrl) throw unknownSubmission(new Error('missing task identity'), clientTaskId);
    try { onTaskSubmitted?.({ taskId: taskId || undefined, model: body.model, status: statusFromPayload(payload),
        initialResponse: payload, clientTaskId }); } catch (_) { /* Persistence callbacks must not abort a submitted task. */ }
    const status = statusFromPayload(payload);
    const completed = initialUrl && (TERMINAL_SUCCESS.has(status) || !status)
        ? { payload, url: safeOutputUrl(initialUrl), taskId }
        : await pollShanhaiTask({ base, key: apiKey, taskId, fetcher, signal, onProgress,
            maxPolls: resolved.maxPolls, maxRetries: resolved.maxRetries, pollIntervalMs: resolved.pollIntervalMs });
    return downloadShanhaiVideo({ ...resolved, url: completed.url, taskId: completed.taskId || taskId,
        key: apiKey, fetcher, onProgress, options: resolved });
}

async function resumeShanhaiVideo(options = {}) {
    const resolved = resolveShanhaiOptions(options);
    const { endpoint, apiKey, prompt, signal, fetchImpl, net, onProgress, taskId } = resolved;
    const base = shanhaiEndpoint(endpoint);
    const remoteTaskId = String(taskId || '').trim();
    if (!remoteTaskId) throw new Error('缺少可恢复的山海任务 ID');
    if (!apiKey) throw new Error('Shanhai API Key 不能为空');
    const fetcher = fetchFunction(fetchImpl, net);
    const completed = await pollShanhaiTask({ base, key: apiKey, taskId: remoteTaskId, fetcher, signal, onProgress,
        maxPolls: resolved.maxPolls, maxRetries: resolved.maxRetries, pollIntervalMs: resolved.pollIntervalMs });
    return downloadShanhaiVideo({ ...resolved, url: completed.url, taskId: completed.taskId, prompt, key: apiKey,
        fetcher, onProgress, options: resolved });
}

module.exports = { isShanhaiEndpoint, isShanhaiModel, shanhaiReferenceLimits, buildShanhaiGenerationBody,
    generateShanhaiVideo, resumeShanhaiVideo };
