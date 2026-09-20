const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { mapLocalError, safeTaskId } = require('../shared/public-api-error.cjs');
const { diagnostic, sanitize } = require('./diagnostics.cjs');

const MODEL = 'sd_2.5_discount_v1';
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
const LIMITS = { image: 30, video: 10, audio: 10 };
const RESPONSE_REQUEST_ID = Symbol('responseRequestId');
const isGlobalAiOpcModel = model => String(model || '').trim().toLowerCase() === MODEL;

function globalAiOpcEndpoint(endpoint) {
    const url = new URL(String(endpoint || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('GlobalAiOpc API 地址必须使用 HTTPS');
    const base = url.pathname.replace(/\/+$/, '');
    if (!['', '/kyyReactApiServer', '/kyyReactApiServer/v2', '/kyyReactApiServer/v2/model-center/tasks'].includes(base)) {
        throw new Error('GlobalAiOpc API 地址应为站点、kyyReactApiServer 前缀或完整任务接口');
    }
    url.pathname = '/kyyReactApiServer/v2/model-center/tasks';
    url.search = ''; url.hash = '';
    return url.toString();
}

function mediaUrls(values, max, label) {
    if (!Array.isArray(values) || values.length > max) throw new Error(`GlobalAiOpc 最多支持 ${max} 个${label}`);
    return values.map(value => {
        const url = String(value || '').trim();
        if (/^assetId:\/\/[a-zA-Z0-9_-]+$/.test(url)) return url;
        let parsed;
        try { parsed = new URL(url); } catch { /* Report the field without exposing its value. */ }
        if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
            throw new Error(`GlobalAiOpc ${label}需要可访问的 URL 或 assetId，不支持 Base64`);
        }
        return url;
    });
}

function buildGlobalAiOpcBody({ model = MODEL, prompt, duration = 4, aspectRatio = '16:9', resolution = '720p',
    seed = -1, generateAudio = true, referenceImages = [], referenceVideos = [], referenceAudios = [] } = {}) {
    if (!isGlobalAiOpcModel(model)) throw new Error('GlobalAiOpc 模型标识无效');
    const text = String(prompt || '').trim();
    if (!text) throw new Error('GlobalAiOpc 提示词不能为空');
    if (!Number.isInteger(Number(duration)) || Number(duration) < 4 || Number(duration) > 30) throw new Error('GlobalAiOpc 时长必须为 4 到 30 秒的整数');
    if (!RATIOS.includes(aspectRatio)) throw new Error('GlobalAiOpc 画幅比例不受支持');
    if (!['480p', '720p', '1080p'].includes(resolution)) throw new Error('GlobalAiOpc 分辨率不受支持');
    if (!Number.isSafeInteger(Number(seed))) throw new Error('GlobalAiOpc seed 必须为整数');
    if (typeof generateAudio !== 'boolean') throw new Error('GlobalAiOpc generate_audio 必须为布尔值');
    const images = mediaUrls(referenceImages, LIMITS.image, '参考图片');
    const videos = mediaUrls(referenceVideos, LIMITS.video, '参考视频');
    const audios = mediaUrls(referenceAudios, LIMITS.audio, '参考音频');
    const body = { model: MODEL, prompt: text, duration: Number(duration), aspect_ratio: aspectRatio,
        resolution, seed: Number(seed), generate_audio: generateAudio };
    // Use the documented wire example for first/last frames; mixed media uses references.
    if (images.length && images.length <= 2 && !videos.length && !audios.length) {
        body.first_image = images[0];
        if (images[1]) body.last_image = images[1];
    } else if (images.length) body.reference_images = images;
    if (videos.length) body.reference_videos = videos;
    if (audios.length) body.reference_audios = audios;
    return body;
}

class GlobalAiOpcAssets {
    constructor({ directory, fetch, wait, maxPolls = 60 }) {
        Object.assign(this, { directory, fetch, wait, maxPolls });
        this.file = path.join(directory, 'globalaiopc-assets.json');
        this.entries = {}; this.pending = new Map(); this.failures = new WeakSet();
        try { this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8')).entries || {}; }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('GlobalAiOpc 素材缓存无法读取，请检查缓存文件'); }
    }
    save() {
        const entries = Object.entries(this.entries).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 500);
        this.entries = Object.fromEntries(entries);
        fs.mkdirSync(this.directory, { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, entries: this.entries }));
        fs.renameSync(`${this.file}.tmp`, this.file);
    }
    failure(status, payload, context, code) {
        const { endpoint, apiKey, action, taskId, clientTaskId, requestId, clientRequestId, assetId } = context;
        const url = new URL(globalAiOpcEndpoint(endpoint));
        diagnostic('error', 'video.asset_failed', sanitize({
            endpointRef: createHash('sha256').update(url.origin + url.pathname).digest('hex').slice(0, 12),
            model: MODEL, action, status, taskId, clientTaskId, requestId, clientRequestId, assetId, detail: payload
        }, [apiKey, encodeURIComponent(apiKey)]));
        const mapped = mapLocalError(status, payload, { query: true, taskId, requestId, ...(code ? { code } : {}) });
        // An asset ID or its request ID is not a submitted video task.
        mapped.taskId = safeTaskId(taskId) || undefined;
        const error = Object.assign(new Error(mapped.error), mapped, { status });
        this.failures.add(error);
        return error;
    }
    async request(endpoint, apiKey, action, body, signal, identifiers = {}) {
        signal?.throwIfAborted();
        const url = new URL(globalAiOpcEndpoint(endpoint));
        url.pathname = `/kyyReactApiServer/asset/seedance2/${action}`;
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; abort(); }, 45000);
        const context = { ...identifiers, clientRequestId: identifiers.requestId, endpoint, apiKey, action, assetId: body.assetId };
        try {
            const response = await this.fetch(url.toString(), { method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body), redirect: 'error', signal: controller.signal });
            context.requestId = response.headers?.get('x-request-id') || response.headers?.get('request-id')
                || response.headers?.get('x-log-id') || context.requestId;
            const text = await response.text();
            let payload;
            try { payload = JSON.parse(text); }
            catch { throw this.failure(response.status, text, context, response.ok ? 'RH_INVALID_RESPONSE' : undefined); }
            const data = payload?.data || payload;
            context.requestId = payload?.error?.request_id || payload?.request_id || payload?.requestId
                || data?.request_id || data?.requestId || context.requestId;
            if (!response.ok || !data?.assetId || !data?.status) {
                throw this.failure(response.status, payload, context);
            }
            if (context.requestId) data[RESPONSE_REQUEST_ID] = context.requestId;
            return data;
        } catch (error) {
            signal?.throwIfAborted();
            if (this.failures.has(error)) throw error;
            throw this.failure(timedOut ? 504 : 502, { error: { message: error?.message || String(error) } }, context,
                timedOut ? 'RH_REQUEST_TIMEOUT' : 'RH_SERVICE_UNAVAILABLE');
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    async resolve({ endpoint, apiKey, url, assetType, signal, onProgress, taskId, clientTaskId, requestId }) {
        const key = createHash('sha256').update(JSON.stringify([globalAiOpcEndpoint(endpoint), apiKey, assetType, url])).digest('hex');
        // Concurrent jobs serialize the same source; each caller retains its own cancellation.
        if (this.pending.has(key)) {
            signal?.throwIfAborted();
            await new Promise((resolve, reject) => {
                const abort = () => reject(Object.assign(new Error('生成任务已中断'), { name: 'AbortError' }));
                signal?.addEventListener('abort', abort, { once: true });
                this.pending.get(key).catch(() => {}).finally(() => {
                    signal?.removeEventListener('abort', abort); resolve();
                });
            });
            signal?.throwIfAborted();
            return this.resolve({ endpoint, apiKey, url, assetType, signal, onProgress, taskId, clientTaskId, requestId });
        }
        const work = this.resolveOne({ key, endpoint, apiKey, url, assetType, signal, onProgress, taskId, clientTaskId, requestId });
        this.pending.set(key, work);
        try { return await work; } finally { this.pending.delete(key); }
    }
    async resolveOne({ key, endpoint, apiKey, url, assetType, signal, onProgress, taskId, clientTaskId, requestId }) {
        signal?.throwIfAborted();
        const identifiers = { taskId, clientTaskId, requestId };
        const context = { endpoint, apiKey, action: 'assetReview', ...identifiers, clientRequestId: requestId };
        const cached = this.entries[key];
        let data = cached?.assetId
            ? await this.request(endpoint, apiKey, 'assetDetail', { assetId: cached.assetId }, signal, identifiers)
            : await this.request(endpoint, apiKey, 'assetUpload', { assetType, url, model: 'sd_2.5' }, signal, identifiers);
        this.entries[key] = { assetId: data.assetId, updatedAt: Date.now() }; this.save();
        for (let attempt = 0; attempt <= this.maxPolls; attempt++) {
            signal?.throwIfAborted();
            context.requestId = data[RESPONSE_REQUEST_ID] || requestId;
            if (data.status === 'ACTIVE') return `assetId://${data.assetId}`;
            if (['FAILED', 'DELETED'].includes(data.status)) {
                delete this.entries[key]; this.save();
                const payload = { ...data, error: { message: data.errorMessage || 'Reference media moderation failed' } };
                throw this.failure(200, payload, { ...context, assetId: data.assetId });
            }
            if (!['NONE', 'UPLOADING', 'PROCESSING', 'EXPIRED'].includes(data.status)) {
                throw this.failure(200, data, { ...context, assetId: data.assetId }, 'RH_INVALID_RESPONSE');
            }
            if (attempt === this.maxPolls) break;
            onProgress?.({ stage: 'upload', message: '等待参考素材审核', remoteStatus: data.status });
            await this.wait(5000, signal);
            data = await this.request(endpoint, apiKey, 'assetDetail', { assetId: data.assetId }, signal, identifiers);
        }
        throw this.failure(200, data, { ...context, assetId: data.assetId }, 'RH_ASSET_PENDING');
    }
    async prepare({ endpoint, apiKey, imageUrls, videoUrls, audioUrls, signal, onProgress, taskId, clientTaskId, requestId }) {
        const result = {};
        for (const [field, assetType, urls] of [['referenceImages', 'Image', imageUrls],
            ['referenceVideos', 'Video', videoUrls], ['referenceAudios', 'Audio', audioUrls]]) {
            result[field] = [];
            for (const url of urls) result[field].push(await this.resolve({ endpoint, apiKey, url, assetType, signal, onProgress,
                taskId, clientTaskId, requestId }));
        }
        return result;
    }
}

module.exports = { MODEL, LIMITS, isGlobalAiOpcModel, globalAiOpcEndpoint, buildGlobalAiOpcBody, GlobalAiOpcAssets };
