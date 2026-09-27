const SD2_FAST_DURATION_CODE = 'LOCAL_SD2_FAST_DURATION_OUT_OF_RANGE';
const SD2_FAST_DURATION_MESSAGE = 'SD2 Fast \u65f6\u957f\u9700\u8981\u4e3a\u6574\u6570\uff1a720p \u652f\u6301 1 \u5230 12 \u79d2\uff0c480p \u652f\u6301 1 \u5230 15 \u79d2\u3002\u8bf7\u8c03\u6574\u65f6\u957f\u6216\u5206\u8fa8\u7387\u540e\u91cd\u65b0\u63d0\u4ea4\u3002';

function isSd2FastProvider(provider) {
    if (String(provider?.model || '').trim().toLowerCase() !== 'sd2-fast') return false;
    try {
        return ['art.ravenhash.org', 'cart.ravenhash.org', 'yueqi.icu']
            .includes(new URL(String(provider?.endpoint || '').trim()).hostname.toLowerCase());
    } catch { return false; }
}

function getSd2FastDurationConstraint(provider, resolution) {
    if (!isSd2FastProvider(provider)) return null;
    const value = String(resolution || '720p').trim().toLowerCase();
    if (!['480p', '720p'].includes(value)) return null;
    return { min: 1, max: value === '720p' ? 12 : 15, resolution: value };
}

function createSd2FastDurationError() {
    return Object.assign(new Error(SD2_FAST_DURATION_MESSAGE), {
        code: SD2_FAST_DURATION_CODE,
        retryable: false
    });
}

module.exports = { SD2_FAST_DURATION_CODE, SD2_FAST_DURATION_MESSAGE,
    isSd2FastProvider, getSd2FastDurationConstraint, createSd2FastDurationError };
