const RELAY_HOSTS = new Set(['art.ravenhash.org', 'cart.ravenhash.org']);
const PRICE_UNITS = new Set(['request', 'second', 'image', 'million_tokens']);
const CURRENCIES = new Set(['CNY', 'USD']);
const UNKNOWN_UPDATED_AT = '1970-01-01T00:00:00.000Z';

// The input is the validated, allowlisted admin sale-price projection, never raw relay data.
export function withCatalogSalePrices(config, snapshot) {
    if (!Array.isArray(config?.models)) return config;
    const sites = new Map((snapshot?.sites || []).map(site => [site.host, site]));
    return {
        ...config,
        models: config.models.map(entry => {
            const modelEntry = { ...entry };
            delete modelEntry.salePrices;
            const hosts = [...new Set(entry.catalog?.hosts || [])].filter(host => RELAY_HOSTS.has(host));
            if (!hosts.length || typeof entry.catalog?.model !== 'string' || !entry.catalog.model) return modelEntry;
            return {
                ...modelEntry,
                salePrices: hosts.map(host => {
                    const site = sites.get(host);
                    const model = site?.models.find(item => item.model === entry.catalog.model);
                    const currency = CURRENCIES.has(model?.currency) ? model.currency
                        : CURRENCIES.has(site?.currency) ? site.currency : 'CNY';
                    const known = model?.status === 'known' && CURRENCIES.has(model.currency)
                        && model.prices.length > 0 && model.prices.every(price => PRICE_UNITS.has(price.unit));
                    return {
                        host,
                        status: known ? 'known' : 'unknown',
                        currency,
                        kind: 'sale',
                        source: 'relay billing snapshot',
                        updatedAt: site?.checkedAt || UNKNOWN_UPDATED_AT,
                        prices: known ? model.prices.map(({ label, amount, unit }) => ({ label, amount, unit })) : [],
                        ...(model?.reason ? { note: model.reason } : {})
                    };
                })
            };
        })
    };
}
