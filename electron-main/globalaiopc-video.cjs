const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MODEL = 'sd_2.5_discount_v1';
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
const LIMITS = { image: 30, video: 10, audio: 10 };
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
        this.entries = {}; this.pending = new Map();
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
    async request(endpoint, apiKey, action, body, signal) {
        signal?.throwIfAborted();
        const url = new URL(globalAiOpcEndpoint(endpoint));
        url.pathname = `/kyyReactApiServer/asset/seedance2/${action}`;
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 45000);
        try {
            const response = await this.fetch(url.toString(), { method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body), redirect: 'error', signal: controller.signal });
            const payload = await response.json();
            const data = payload?.data || payload;
            if (!response.ok || !data?.assetId || !data?.status) {
                const detail = String(data?.errorMessage || payload?.message || `HTTP ${response.status}`).split(apiKey).join('[redacted]');
                throw new Error(`GlobalAiOpc 素材${action === 'assetUpload' ? '提交' : '查询'}失败：${detail.slice(0, 500)}`);
            }
            return data;
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    async resolve({ endpoint, apiKey, url, assetType, signal, onProgress }) {
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
            return this.resolve({ endpoint, apiKey, url, assetType, signal, onProgress });
        }
        const work = this.resolveOne({ key, endpoint, apiKey, url, assetType, signal, onProgress });
        this.pending.set(key, work);
        try { return await work; } finally { this.pending.delete(key); }
    }
    async resolveOne({ key, endpoint, apiKey, url, assetType, signal, onProgress }) {
        signal?.throwIfAborted();
        const cached = this.entries[key];
        let data = cached?.assetId
            ? await this.request(endpoint, apiKey, 'assetDetail', { assetId: cached.assetId }, signal)
            : await this.request(endpoint, apiKey, 'assetUpload', { assetType, url, model: 'sd_2.5' }, signal);
        this.entries[key] = { assetId: data.assetId, updatedAt: Date.now() }; this.save();
        for (let attempt = 0; attempt <= this.maxPolls; attempt++) {
            signal?.throwIfAborted();
            if (data.status === 'ACTIVE') return `assetId://${data.assetId}`;
            if (['FAILED', 'DELETED'].includes(data.status)) {
                delete this.entries[key]; this.save();
                const detail = String(data.errorMessage || data.status).split(apiKey).join('[redacted]');
                throw new Error(`GlobalAiOpc 素材审核未通过：${detail.slice(0, 500)}`);
            }
            if (!['NONE', 'UPLOADING', 'PROCESSING', 'EXPIRED'].includes(data.status)) throw new Error('GlobalAiOpc 返回了未知素材状态');
            if (attempt === this.maxPolls) break;
            onProgress?.({ stage: 'upload', message: '等待 GlobalAiOpc 素材审核', remoteStatus: data.status });
            await this.wait(5000, signal);
            data = await this.request(endpoint, apiKey, 'assetDetail', { assetId: data.assetId }, signal);
        }
        throw new Error('GlobalAiOpc 素材仍在审核，尚未提交视频任务；稍后重试会复用素材 ID');
    }
    async prepare({ endpoint, apiKey, imageUrls, videoUrls, audioUrls, signal, onProgress }) {
        const result = {};
        for (const [field, assetType, urls] of [['referenceImages', 'Image', imageUrls],
            ['referenceVideos', 'Video', videoUrls], ['referenceAudios', 'Audio', audioUrls]]) {
            result[field] = [];
            for (const url of urls) result[field].push(await this.resolve({ endpoint, apiKey, url, assetType, signal, onProgress }));
        }
        return result;
    }
}

module.exports = { MODEL, LIMITS, isGlobalAiOpcModel, globalAiOpcEndpoint, buildGlobalAiOpcBody, GlobalAiOpcAssets };
