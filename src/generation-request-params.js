import { isGptImage2Model, isMidjourneyImageModel, isNanoBananaModel } from './provider-capabilities.js';
import nanoBanana from '../shared/nano-banana.cjs';

export function imageGenerationRequestParams(config = {}, model = '', nodeId = null) {
    const gptImage2 = isGptImage2Model(model);
    const nativeImage = isNanoBananaModel(model);
    const imageSize = config.resolutionTier || nanoBanana.nanoBananaTier(config.size || `${config.width}x${config.height}`);
    return {
        size: nativeImage ? imageSize : config.size || `${config.width || 1024}x${config.height || 1024}`,
        quality: nativeImage ? undefined : config.quality || 'high',
        responseFormat: gptImage2 ? (config.responseFormat || 'url') : 'url',
        historyDisabled: gptImage2 ? config.historyDisabled !== false : true,
        stream: gptImage2 ? config.stream === true : false,
        webSearch: !nativeImage && config.webSearch === true ? true : undefined,
        nodeId,
        ...(nativeImage ? { ratio: config.ratio || 'adaptive', resolutionTier: imageSize } : {}),
        ...(isMidjourneyImageModel(model) ? { midjourney: {
            ratio: config.ratio, version: config.midjourneyVersion, raw: config.midjourneyRaw === true,
            stylize: config.midjourneyStylize, chaos: config.midjourneyChaos, weird: config.midjourneyWeird,
            quality: config.midjourneyQuality, imageWeight: config.midjourneyImageWeight,
            styleReference: config.midjourneyStyleReference, styleWeight: config.midjourneyStyleWeight,
            styleVersion: config.midjourneyStyleVersion, omniReference: config.midjourneyOmniReference,
            omniWeight: config.midjourneyOmniWeight, profile: config.midjourneyProfile, seed: config.midjourneySeed,
            tile: config.midjourneyTile === true, draft: config.midjourneyDraft === true,
            repeat: config.midjourneyRepeat, speed: config.midjourneySpeed, visibility: config.midjourneyVisibility,
            definition: config.resolutionTier === '2K' ? 'hd' : 'sd', negativePrompt: config.negativePrompt
        } } : {})
    };
}

export function normalizeVideoGenerationResolution(model, resolution) {
    if (!/minimax[^a-z0-9]*h3/i.test(String(model || '')) || !resolution) return resolution;
    const value = String(resolution).trim().toLowerCase();
    return value === '720p' ? '768p' : value;
}
