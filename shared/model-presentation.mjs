const PRESENTATION_FIELDS = ['label', 'description', 'routeLabel', 'routeGroup', 'routeGroupLabel', 'routeGroupDescription', 'routeModelLabel'];
const PRICE_UNITS = { request: '次', image: '张', second: '秒' };
const SALE_PRICE_UNITS = { ...PRICE_UNITS, million_tokens: '百万 Token' };
const SALE_PRICE_HOSTS = { 'art.ravenhash.org': '老站', 'cart.ravenhash.org': '新站' };
const SALE_PRICE_FIELDS = ['host', 'status', 'currency', 'kind', 'source', 'updatedAt', 'prices', 'note'];

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
    for (const field of ['recommended', 'routeGroupAlways', 'visible']) {
        if (typeof presentation?.[field] === 'boolean') result[field] = presentation[field];
    }
    for (const field of ['routeGroupOrder', 'routeOrder']) {
        const value = presentation?.[field];
        if (Number.isInteger(value) && value >= -100000 && value <= 100000) result[field] = value;
    }
    if (['provider', 'catalog'].includes(presentation?.routeGroupScope)) {
        result.routeGroupScope = presentation.routeGroupScope;
    }

    const pricing = entry?.pricing;
    let host = '';
    try { host = new URL(provider.endpoint).hostname.toLowerCase(); } catch (_) { /* No configured endpoint. */ }
    if (entry && Object.hasOwn(entry, 'salePrices')) {
        const matches = Array.isArray(entry.salePrices) ? entry.salePrices.filter(price => price?.host === host) : [];
        const selected = matches.length === 1 && isModelSalePricing(matches[0]) ? matches[0] : null;
        result.salePricing = selected;
        result.price = null;
        if (selected?.status === 'known') {
            const first = selected.prices[0];
            if (selected.prices.every(price => price.amount === first.amount && price.unit === first.unit)) {
                const { currency, kind, source, updatedAt } = selected;
                result.price = { amount: first.amount, unit: first.unit, currency, kind, source, updatedAt };
            }
        }
        return result;
    }
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

function isModelSalePricing(pricing) {
    return pricing?.kind === 'sale' && Object.hasOwn(SALE_PRICE_HOSTS, pricing.host)
        && Object.keys(pricing).every(field => SALE_PRICE_FIELDS.includes(field))
        && ['known', 'unknown'].includes(pricing.status) && ['CNY', 'USD'].includes(pricing.currency)
        && typeof pricing.source === 'string' && Boolean(pricing.source.trim())
        && typeof pricing.updatedAt === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(pricing.updatedAt)
        && Number.isFinite(Date.parse(pricing.updatedAt))
        && (pricing.note === undefined || typeof pricing.note === 'string')
        && Array.isArray(pricing.prices) && (pricing.status === 'unknown' || pricing.prices.length > 0)
        && pricing.prices.every(price => typeof price?.label === 'string'
            && Object.keys(price).every(field => ['label', 'amount', 'unit'].includes(field))
            && Number.isFinite(price.amount) && price.amount >= 0 && Object.hasOwn(SALE_PRICE_UNITS, price.unit));
}

function normalizePriceResolution(value) {
    const match = String(value ?? '').toLowerCase().match(/(?:^|[^a-z0-9])(\d{3,4}p|\d+(?:\.\d+)?k)(?=$|[^a-z0-9])/);
    return match?.[1] === '786p' ? '768p' : match?.[1] || '';
}

function priceVideoReference(label) {
    if (/无(?:参考)?视频/.test(label)) return false;
    if (/有(?:参考)?视频/.test(label)) return true;
    return null;
}

function narrowPriceTiers(prices, readValue, value) {
    if (!prices.some(price => readValue(price) === value)) return prices;
    // Unlabelled tiers remain possible when the catalog does not describe the condition.
    return prices.filter(price => readValue(price) === value || readValue(price) === null);
}

function formatSaleAmount(amount, currency) {
    return `${currency === 'CNY' ? '¥' : 'US$'}${amount.toFixed(2)}`;
}

export function formatModelSalePrice(salePricing, { resolution, hasVideoReference } = {}) {
    if (!isModelSalePricing(salePricing) || salePricing.status !== 'known') return '售价待配置';
    let prices = salePricing.prices;
    const normalizedResolution = normalizePriceResolution(resolution);
    if (normalizedResolution) {
        prices = narrowPriceTiers(prices, price => normalizePriceResolution(price.label) || null, normalizedResolution);
    }
    if (typeof hasVideoReference === 'boolean') {
        prices = narrowPriceTiers(prices, price => priceVideoReference(price.label), hasVideoReference);
    }
    const units = [...new Set(prices.map(price => price.unit))];
    return units.map(unit => {
        const amounts = prices.filter(price => price.unit === unit).map(price => price.amount);
        const min = Math.min(...amounts);
        const max = Math.max(...amounts);
        const range = min.toFixed(2) === max.toFixed(2) ? '' : `-${max.toFixed(2)}`;
        return `${formatSaleAmount(min, salePricing.currency)}${range}/${SALE_PRICE_UNITS[unit]}`;
    }).join('；');
}

export function formatModelSalePriceDetails(salePricing, { includeSite = true } = {}) {
    if (!isModelSalePricing(salePricing)) return '售价待配置';
    const lines = [includeSite ? `${SALE_PRICE_HOSTS[salePricing.host]}售价` : '售价明细'];
    if (salePricing.status === 'known') {
        for (const price of salePricing.prices) {
            lines.push(`${price.label ? `${price.label}：` : ''}${formatSaleAmount(price.amount, salePricing.currency)}/${SALE_PRICE_UNITS[price.unit]}`);
        }
    } else lines.push('售价待配置');
    if (salePricing.note?.trim()) lines.push(salePricing.note.trim());
    return lines.join('\n');
}

export function describeModelPresentation(profile, fallback = '', { includePrice = true } = {}) {
    return [profile?.description ?? fallback, includePrice ? formatModelPrice(profile?.price) : ''].filter(Boolean).join('；');
}
