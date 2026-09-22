const text = value => typeof value === 'string' && value.trim().length > 0;
const list = value => Array.isArray(value) && value.length > 0 && value.every(text);
const timestamp = value => text(value) && Number.isFinite(Date.parse(value));
const units = new Set(['request', 'second', 'image', 'million_tokens']);

export function projectAdminModelCosts(value) {
    const fail = () => { throw new Error('Invalid supplier cost catalog'); };
    if (!value || !timestamp(value.checkedAt) || !Array.isArray(value.entries)) fail();
    const entries = value.entries.map(entry => {
        if (!entry || !list(entry.ids) || !list(entry.models) || !text(entry.supplier)
            || !['reference', 'historical', 'unknown'].includes(entry.status) || !text(entry.note)
            || !Array.isArray(entry.prices) || !text(entry.sourceUrl)) fail();
        const url = new URL(entry.sourceUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail();
        if (entry.status !== 'unknown' && (!['CNY', 'USD', 'CREDITS'].includes(entry.currency) || !entry.prices.length)) fail();
        if (entry.status === 'historical' && !timestamp(entry.quotedAt)) fail();
        const prices = entry.prices.map(price => {
            if (!price || typeof price.label !== 'string' || !Number.isFinite(price.amount) || price.amount < 0 || !units.has(price.unit)) fail();
            return { label: price.label, amount: price.amount, unit: price.unit };
        });
        return { ids: entry.ids, models: entry.models, supplier: entry.supplier, sourceUrl: entry.sourceUrl,
            status: entry.status, note: entry.note, currency: entry.currency, quotedAt: entry.quotedAt, prices };
    });
    return { checkedAt: value.checkedAt, entries };
}
