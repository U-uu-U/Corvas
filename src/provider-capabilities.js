export const PROVIDER_CAPABILITIES = Object.freeze({
    // Text providers also own multimodal understanding and reverse prompting.
    TEXT: 'text',
    IMAGE: 'image',
    VIDEO: 'video'
});

export function normalizeProviderCapability(value) {
    const capability = String(value || '').trim().toLowerCase();
    if (['chat', 'vision', 'multimodal', 'text-vision'].includes(capability)) {
        return PROVIDER_CAPABILITIES.TEXT;
    }
    return Object.values(PROVIDER_CAPABILITIES).includes(capability) ? capability : '';
}

export function inferProviderCapability(provider = {}) {
    const explicit = normalizeProviderCapability(provider.capability);
    if (explicit) return explicit;

    const marker = `${provider.model || ''} ${provider.endpoint || ''} ${provider.name || ''}`.toLowerCase();
    if (/^ch0107-sd-2\.5-720p(?:\s|$)/.test(marker)) return PROVIDER_CAPABILITIES.VIDEO;
    if (/(seedance|^sd_2\.5_discount_v1(?:\s|$)|^sd2[._-]?5(?:-route[12]|-haidiyue-face)?(?:\s|$)|artsdance|dreamina|video|kling|可灵|sora|runway|veo|vidu|minimax[^a-z0-9]*h3|hunyuan|腾讯|通义.*视频|wan[^\s]*(?:t2v|i2v))/.test(marker)) {
        return PROVIDER_CAPABILITIES.VIDEO;
    }
    if (/(image|gpt-image|dall-e|imagen|flux|stable|sdxl|midjourney)/.test(marker)) {
        return PROVIDER_CAPABILITIES.IMAGE;
    }
    return PROVIDER_CAPABILITIES.TEXT;
}

export function providerHasCapability(provider, capability) {
    if (!provider) return false;
    return inferProviderCapability(provider) === normalizeProviderCapability(capability);
}

export function canUseTextProvider(provider) {
    if (!provider?.model) return false;
    const capability = normalizeProviderCapability(provider.capability);
    if (capability && capability !== PROVIDER_CAPABILITIES.TEXT) return false;
    // A saved role is not proof that a dedicated generation model supports chat.
    const model = String(provider.model).trim().toLowerCase();
    if (model === 'ch0107-sd-2.5-720p') return false;
    return !/^(?:gpt[-_]image(?:[-_.]|$)|dall[-_]?e(?:[-_.]|$)|mj_imagine$|midjourney$|(?:doubao[-_])?seedance|artsdance|sd_2\.5_discount_v1$|sd2[._-]?5(?:[-_]|$)|minimax[-_]?h3(?:[-_]|$))/.test(model);
}

export function textProviderError(provider) {
    return canUseTextProvider(provider) ? null : {
        success: false,
        code: 'TEXT_PROVIDER_REQUIRED',
        error: '此步骤需要文字或视觉理解模型，不能使用图片或视频生成模型。请重新选择文字模型，图片 API 配置无需修改。'
    };
}

export function isMidjourneyImageModel(model) {
    const normalized = String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    return normalized === 'mjimagine' || normalized === 'midjourney';
}

export function isGptImage2Model(model) {
    const normalized = String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    return normalized === 'gptimage2';
}
