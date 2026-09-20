// Pause new submissions only. Keep provider records and task recovery available.
const PAUSED_MODELS = {
    'art.ravenhash.org': ['seedance_v2.5-101010', 'seedance_v2.5-301010'],
    'cart.ravenhash.org': ['seedance_v2.5-101010', 'seedance_v2.5-301010'],
    'zcbservice.aizfw.cn': ['sd_2.5_discount_v1'],
    'api.xzapi.vip': ['ch0107-sd-2.5-720p']
};

export function isVideoGenerationAvailable(provider) {
    let host;
    try { host = new URL(provider?.endpoint).hostname.toLowerCase(); } catch { return true; }
    return !PAUSED_MODELS[host]?.includes(String(provider?.model || '').trim().toLowerCase());
}

export function assertVideoGenerationAvailable(provider) {
    if (!isVideoGenerationAvailable(provider)) {
        throw Object.assign(new Error(`模型 ${provider.model} 已暂时停用，请选择其他渠道；已有任务仍可恢复。`), {
            code: 'VIDEO_MODEL_PAUSED'
        });
    }
}
