const PRESENTATION_FIELDS = ['label', 'description', 'routeLabel', 'routeGroup', 'routeGroupLabel', 'routeModelLabel'];
const PRICE_UNITS = { request: '次', image: '张', second: '秒' };

// Display metadata never changes the wire model, endpoint or account binding.
export function getModelPresentation(entry, provider = {}) {
    const result = {};
    const presentation = entry?.presentation;
    for (const field of PRESENTATION_FIELDS) {
        if (typeof presentation?.[field] === 'string') {
            const value = presentation[field].trim();
            if (field !== 'label' || value) result[field] = value;
        }
    }
    if (typeof presentation?.recommended === 'boolean') result.recommended = presentation.recommended;

    const pricing = entry?.pricing;
    let host = '';
    try { host = new URL(provider.endpoint).hostname.toLowerCase(); } catch (_) { /* No configured endpoint. */ }
    if (!host || !Array.isArray(pricing?.hosts)
        || !pricing.hosts.some(value => typeof value === 'string' && value.toLowerCase() === host)) return result;
    if (pricing.status === 'unknown') result.price = null;
    else if (pricing.status === 'known' && isSalePrice(pricing)) {
        const { amount, currency, unit, kind, source, updatedAt } = pricing;
        result.price = { amount, currency, unit, kind, source, updatedAt };
    }
    return result;
}

function isSalePrice(price) {
    return price?.kind === 'sale' && Number.isFinite(price.amount) && price.amount >= 0
        && ['CNY', 'USD'].includes(price.currency) && Object.hasOwn(PRICE_UNITS, price.unit)
        && typeof price.source === 'string' && Boolean(price.source.trim())
        && typeof price.updatedAt === 'string' && Number.isFinite(Date.parse(price.updatedAt));
}

export function formatModelPrice(price) {
    if (price === null) return '费用未知';
    if (!isSalePrice(price)) return '';
    const amount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(price.amount);
    return `${price.currency === 'CNY' ? '¥' : 'US$'}${amount}/${PRICE_UNITS[price.unit]}`;
}

export function describeModelPresentation(profile, fallback = '', { includePrice = true } = {}) {
    return [profile?.description ?? fallback, includePrice ? formatModelPrice(profile?.price) : ''].filter(Boolean).join('；');
}
