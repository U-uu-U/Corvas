const NANO_BANANA_MODEL = 'gemini-nano-banana-2.1';
const NANO_BANANA_TIERS = ['1K', '2K', '4K'];
const NANO_BANANA_RATIOS = ['adaptive', '1:1', '9:16', '16:9', '3:4', '4:3', '2:3', '3:2', '4:5', '5:4', '21:9', '1:4', '4:1', '1:8', '8:1'];

function isNanoBananaModel(model) {
    return String(model || '').trim().toLowerCase() === NANO_BANANA_MODEL;
}

function nanoBananaTier(value) {
    const size = String(value || '').trim().toUpperCase();
    if (NANO_BANANA_TIERS.includes(size)) return size;
    const dimensions = /^(\d+)X(\d+)$/.exec(size);
    if (!dimensions) return '1K';
    const edge = Math.max(Number(dimensions[1]), Number(dimensions[2]));
    return edge >= 2800 ? '4K' : edge >= 1800 ? '2K' : '1K';
}

module.exports = { NANO_BANANA_MODEL, NANO_BANANA_TIERS, NANO_BANANA_RATIOS, isNanoBananaModel, nanoBananaTier };
