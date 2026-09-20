const { createHash } = require('node:crypto');

const STARFRAME_MODEL = 'ch0107-sd-2.5-720p';
const STARFRAME_LIMITS = { image: 30, video: 10, audio: 10 };
const isStarFrameModel = model => String(model || '').trim().toLowerCase() === STARFRAME_MODEL;

function starFrameEndpoint(endpoint) {
    const url = new URL(String(endpoint || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('StarFrame API 地址必须使用 HTTPS');
    if (!['', '/', '/v1', '/v1/', '/v1/videos', '/v1/videos/'].includes(url.pathname)) throw new Error('StarFrame API 地址应为站点、/v1 或 /v1/videos');
    url.pathname = '/v1/videos'; url.search = ''; url.hash = '';
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
    if (!isStarFrameModel(model)) throw new Error('StarFrame 模型标识无效');
    const text = String(prompt || '').trim();
    if (!text) throw new Error('StarFrame 提示词不能为空');
    if (!Number.isInteger(Number(duration)) || Number(duration) < 4 || Number(duration) > 30) throw new Error('StarFrame 时长必须为 4 到 30 秒的整数');
    if (resolution !== '720p') throw new Error('ch0107-sd-2.5-720p 仅支持 720p');
    const images = urls(referenceImages, STARFRAME_LIMITS.image, '参考图片');
    const videos = urls(referenceVideos, STARFRAME_LIMITS.video, '参考视频');
    const audios = urls(referenceAudios, STARFRAME_LIMITS.audio, '参考音频');
    const body = { model: STARFRAME_MODEL, client_task_id: starFrameClientId(clientTaskId), prompt: text,
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
    if (!taskId) throw new Error('StarFrame 完成响应缺少任务 ID');
    const base = starFrameEndpoint(endpoint);
    const expected = new URL(`${base}/${encodeURIComponent(taskId)}/content`);
    const url = new URL(payload.metadata?.url || expected.href, base);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.search || url.hash) {
        throw new Error('StarFrame 产物路径与当前任务不符，未发送鉴权信息');
    }
    return url.href;
}

module.exports = { STARFRAME_MODEL, STARFRAME_LIMITS, isStarFrameModel, starFrameEndpoint, starFrameClientId, buildStarFrameBody, starFrameContentUrl };
