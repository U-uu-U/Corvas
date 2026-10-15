const sharp = require('sharp');
const { NANO_BANANA_TIERS, NANO_BANANA_RATIOS, isNanoBananaModel, nanoBananaTier } = require('../shared/nano-banana.cjs');
const { createParameterValidationError } = require('../shared/model-parameter-rules.cjs');

function buildNanoBananaEndpoint(endpoint, model) {
    if (!isNanoBananaModel(model)) throw new Error('Unsupported Nano Banana model');
    const url = new URL(endpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid image API endpoint');
    const prefix = url.pathname.replace(/\/(?:v1|v1beta)(?:\/.*)?\/?$/i, '').replace(/\/+$/, '');
    url.pathname = `${prefix}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

async function buildNanoBananaRequest(prompt, images = [], options = {}) {
    const tier = String(options.resolutionTier || nanoBananaTier(options.size)).toUpperCase();
    if (!NANO_BANANA_TIERS.includes(tier)) throw createParameterValidationError([
        { code: 'VALUE_NOT_ALLOWED', field: 'resolutionTier', allowed: NANO_BANANA_TIERS }
    ]);
    let ratio = options.ratio || 'adaptive';
    if (!options.ratio) {
        const dimensions = /^(\d+)x(\d+)$/i.exec(String(options.size || ''));
        if (dimensions) {
            const requested = Number(dimensions[1]) / Number(dimensions[2]);
            ratio = NANO_BANANA_RATIOS.slice(1).find(value => {
                const [width, height] = value.split(':').map(Number);
                return Math.abs(Math.log(requested / (width / height))) < 0.025;
            }) || '';
        }
    }
    if (!NANO_BANANA_RATIOS.includes(ratio)) throw createParameterValidationError([
        { code: 'VALUE_NOT_ALLOWED', field: 'ratio', allowed: NANO_BANANA_RATIOS }
    ]);
    if (options.n !== undefined && Number(options.n) !== 1) throw createParameterValidationError([
        { code: 'VALUE_MUST_BE', field: 'n', expected: 1 }
    ]);
    const parts = [{ text: String(prompt) }];
    for (const image of images) {
        const metadata = await sharp(image.buffer, { limitInputPixels: 128 * 1024 * 1024 }).metadata();
        const mimeType = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[metadata.format];
        const buffer = mimeType ? image.buffer : await sharp(image.buffer).png().toBuffer();
        parts.push({ inlineData: { mimeType: mimeType || 'image/png', data: buffer.toString('base64') } });
    }
    return { contents: [{ role: 'user', parts }], generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { imageSize: tier, ...(ratio !== 'adaptive' ? { aspectRatio: ratio } : {}) }
    } };
}

function normalizeNanoBananaResponse(payload) {
    if (payload?.error) return payload;
    const reason = payload?.promptFeedback?.blockReason;
    const blocked = reason && reason !== 'BLOCK_REASON_UNSPECIFIED';
    const imageSafety = payload?.candidates?.some(candidate => /SAFETY|PROHIBITED|RECITATION/.test(candidate.finishReason || ''));
    if (blocked || imageSafety) return { status: 'failed', error: { code: 'content_policy_violation',
        message: blocked ? '提示词审核未通过，请调整提示词后重新提交。' : '生成结果未通过内容审核，请调整提示词或参考素材。' } };
    const data = [];
    for (const candidate of payload?.candidates || []) {
        for (const part of candidate.content?.parts || []) {
            const inline = part.inlineData || part.inline_data;
            if (part.thought === true || !/^image\//i.test(inline?.mimeType || inline?.mime_type || '')
                || typeof inline?.data !== 'string' || !inline.data) continue;
            data.push({ b64_json: inline.data });
        }
    }
    if (data.length) return { data };
    return { status: 'failed', error: { code: 'empty_generation_result', message: '生成服务没有返回图片，请调整提示词或联系管理员。' } };
}

module.exports = { buildNanoBananaEndpoint, buildNanoBananaRequest, normalizeNanoBananaResponse };
