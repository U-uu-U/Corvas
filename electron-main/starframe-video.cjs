const { createHash } = require('node:crypto');

const STARFRAME_MODEL = 'ch0107-sd-2.5-720p';
const STARFRAME_MODELS = Object.freeze({
    'ch0107-sd-2.5-720p': Object.freeze({ image: 30, video: 10, audio: 10 }),
    'ch1401-sd-2.5-720p': Object.freeze({ image: 30, video: 0, audio: 0 })
});
const STARFRAME_LIMITS = STARFRAME_MODELS[STARFRAME_MODEL];
const normalizeStarFrameModel = model => {
    const value = String(model || '').trim().toLowerCase();
    return Object.hasOwn(STARFRAME_MODELS, value) ? value : '';
};
const isStarFrameModel = model => Boolean(normalizeStarFrameModel(model));
const starFrameLimits = model => STARFRAME_MODELS[normalizeStarFrameModel(model)] || null;
const RELAY_HOSTS = new Set(['art.ravenhash.org', 'cart.ravenhash.org']);

function starFrameEndpoint(endpoint) {
    const url = new URL(String(endpoint || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('StarFrame API 地址必须使用 HTTPS');
    const relay = RELAY_HOSTS.has(url.hostname);
    const paths = ['', '/', '/v1', '/v1/', '/v1/videos', '/v1/videos/'];
    if (relay) paths.push('/v1/video/generations', '/v1/video/generations/');
    if (!paths.includes(url.pathname)) throw new Error('StarFrame API 地址应为站点、/v1 或 /v1/videos');
    url.pathname = relay ? '/v1/video/generations' : '/v1/videos'; url.search = ''; url.hash = '';
    return url.toString();
}

function starFrameClientId(value) {
    const id = String(value || '').trim();
    if (!id) throw new Error('StarFrame 缺少持久化的客户端任务 ID');
    return /^[a-zA-Z0-9_.-]{1,128}$/.test(id) ? id : `corvas_${createHash('sha256').update(id).digest('hex')}`;
}

function urls(values, limit, label) {
    if (!Array.isArray(values) || values.length > limit) throw new Error(`StarFrame 最多支持 ${limit} 个${label}`);
    return values.map(value => {
        let url;
        try { url = new URL(String(value || '')); } catch { /* Reject without echoing private media. */ }
        if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
            throw new Error(`StarFrame ${label}需要公网 URL，不支持 Base64 或素材 ID`);
        }
        return url.toString();
    });
}

function buildStarFrameBody({ model = STARFRAME_MODEL, clientTaskId, prompt, duration = 4, resolution = '720p',
    aspectRatio, referenceImages = [], referenceVideos = [], referenceAudios = [] } = {}) {
    const normalizedModel = normalizeStarFrameModel(model);
    if (!normalizedModel) throw new Error('StarFrame 模型标识无效');
    const text = String(prompt || '').trim();
    if (!text) throw new Error('StarFrame 提示词不能为空');
    if (!Number.isInteger(Number(duration)) || Number(duration) < 4 || Number(duration) > 30) throw new Error('StarFrame 时长必须为 4 到 30 秒的整数');
    if (resolution !== '720p') throw new Error(`${normalizedModel} 仅支持 720p`);
    const limits = starFrameLimits(normalizedModel);
    const images = urls(referenceImages, limits.image, '参考图片');
    const videos = urls(referenceVideos, limits.video, '参考视频');
    const audios = urls(referenceAudios, limits.audio, '参考音频');
    const body = { model: normalizedModel, client_task_id: starFrameClientId(clientTaskId), prompt: text,
        mode: 'references', duration: Number(duration), resolution: '720p' };
    if (aspectRatio) {
        if (!/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(aspectRatio)
            || String(aspectRatio).split(':').some(value => !(Number(value) > 0))) throw new Error('StarFrame 画幅比例格式无效');
        body.aspect_ratio = aspectRatio;
    }
    const references = {};
    for (const [singular, plural, values] of [['image', 'images', images], ['video', 'videos', videos], ['audio', 'audios', audios]]) {
        if (values.length === 1) references[singular] = values[0];
        else if (values.length > 1) references[plural] = values;
    }
    if (Object.keys(references).length) body.references = references;
    return body;
}

function starFrameContentUrl(endpoint, taskId, payload) {
    if (payload?.status !== 'completed') return '';
    if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(taskId)) throw new Error('StarFrame 完成响应缺少有效任务 ID');
    if (payload.id && payload.id !== taskId) throw new Error('StarFrame 完成响应与原任务 ID 不符');
    const base = starFrameEndpoint(endpoint);
    // Live responses may contain a signed storage URL. Always use the documented
    // task content endpoint so credentials stay bound to the configured API.
    return `${base}/${encodeURIComponent(taskId)}/content`;
}

function starFrameDownloadRequest(endpoint, taskId, payload) {
    const canonical = starFrameContentUrl(endpoint, taskId, payload);
    if (!canonical) return { url: '', requiresAuth: false };
    let candidate;
    const relay = RELAY_HOSTS.has(new URL(endpoint).hostname);
    const resultUrl = payload.metadata?.url || (relay ? payload.data?.[0]?.url || payload.url || payload.video_url : '');
    try { candidate = new URL(resultUrl); } catch { /* Relative URLs use the API endpoint. */ }
    // Verified live StarFrame storage host. Its signed URLs authorize themselves;
    // API credentials must never be attached to storage downloads.
    if (candidate?.protocol === 'https:' && candidate.hostname === 'starframe-sh.tos-s3-cn-shanghai.volces.com'
        && !candidate.username && !candidate.password && candidate.searchParams.has('X-Amz-Signature')) {
        return { url: candidate.href, requiresAuth: false };
    }
    return { url: canonical, requiresAuth: true };
}

module.exports = { STARFRAME_MODEL, STARFRAME_MODELS, STARFRAME_LIMITS, starFrameLimits, isStarFrameModel, starFrameEndpoint, starFrameClientId, buildStarFrameBody, starFrameContentUrl, starFrameDownloadRequest };
