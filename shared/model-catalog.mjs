import { inferProviderCapability, normalizeProviderCapability } from '../src/provider-capabilities.js';

const MODEL_KINDS = new Set(['image', 'video', 'text']);

export function isRemoteCatalog(config) {
    return config?.catalogMode === 'remote';
}

function endpointHostname(endpoint) {
    if (typeof endpoint !== 'string' || !endpoint.trim()) return '';
    try {
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
        return url.hostname.toLowerCase();
    } catch (_) {
        return '';
    }
}

function catalogHostname(value) {
    if (typeof value !== 'string') return '';
    const hostname = value.trim().toLowerCase();
    if (!hostname || /[\s*/?#@]/.test(hostname)) return '';
    try {
        const url = new URL(`https://${hostname}`);
        return url.hostname === hostname && url.host === hostname ? hostname : '';
    } catch (_) {
        return '';
    }
}

function catalogModel(entry) {
    return typeof entry?.catalog?.model === 'string' ? entry.catalog.model.trim() : '';
}

function matchesAccount(entry, provider, hostname) {
    return Boolean(catalogModel(entry)) && MODEL_KINDS.has(entry.kind) && Boolean(entry.id)
        && (!provider.capability || provider.capability === entry.kind)
        && (!provider.kind || provider.kind === entry.kind)
        && Array.isArray(entry.catalog.hosts)
        && entry.catalog.hosts.some(host => catalogHostname(host) === hostname);
}

function entryPriority(entry) {
    return Number.isFinite(entry.priority) ? entry.priority : 0;
}

function accountKind(config, provider, hostname) {
    const explicit = normalizeProviderCapability(provider.kind || provider.capability);
    if (explicit) return explicit;
    const model = String(provider.model || '').trim();
    const matches = (Array.isArray(config.models) ? config.models : [])
        .filter(entry => matchesAccount(entry, provider, hostname) && catalogModel(entry) === model)
        .sort((left, right) => entryPriority(right) - entryPriority(left));
    return matches[0]?.kind || inferProviderCapability({ model: provider.model });
}

export function isCatalogManaged(config, provider) {
    if (!isRemoteCatalog(config)) return false;
    if (!Object.hasOwn(config, 'catalogScope')) return true;
    if (!provider) return false;
    const hostname = endpointHostname(provider.endpoint);
    const scope = config.catalogScope;
    if (!hostname || !Array.isArray(scope?.hosts)
        || !scope.hosts.some(host => catalogHostname(host) === hostname)) return false;
    return Array.isArray(scope.kinds) && scope.kinds.includes(accountKind(config, provider, hostname));
}

export function findCatalogEntry(config, provider) {
    if (!isCatalogManaged(config, provider) || !provider) return null;
    const hostname = endpointHostname(provider.endpoint);
    const model = typeof provider.model === 'string' ? provider.model.trim() : '';
    if (!hostname || !model) return null;
    let selected = null;
    for (const entry of Array.isArray(config.models) ? config.models : []) {
        if (!matchesAccount(entry, provider, hostname) || catalogModel(entry) !== model) continue;
        if (entry.id === provider.catalogEntryId) return entry;
        if (!selected || entryPriority(entry) > entryPriority(selected)) selected = entry;
    }
    return selected;
}

function expandLegacyProviders(providers) {
    return providers.flatMap(provider => {
        const source = Array.isArray(provider?.models) ? provider.models : [provider?.model];
        const models = [...new Set(source.map(model => String(model || '').trim()).filter(Boolean))];
        return models.map((model, index) => ({
            ...provider,
            id: index === 0 ? provider.id : `${provider.id}::model:${encodeURIComponent(model)}`,
            sourceProviderId: provider.id,
            model
        }));
    });
}

export function expandCatalogProviders(config, providers, { includeHidden = false } = {}) {
    const accounts = Array.isArray(providers) ? providers : [];
    if (!isRemoteCatalog(config)) return expandLegacyProviders(accounts);
    const entries = Array.isArray(config.models) ? config.models : [];

    return accounts.flatMap(provider => {
        if (!provider || !provider.id) return [];
        if (!isCatalogManaged(config, provider)) return expandLegacyProviders([provider]);
        const hostname = endpointHostname(provider.endpoint);
        if (!hostname) return [];
        const selected = new Map();
        const kind = config.catalogScope ? accountKind(config, provider, hostname) : null;

        for (const entry of entries) {
            if (!matchesAccount(entry, provider, hostname)) continue;
            if (kind && entry.kind !== kind) continue;
            const model = catalogModel(entry);
            const priority = entryPriority(entry);
            const previous = selected.get(model);
            if (!previous || priority > previous.priority) selected.set(model, { entry, priority });
        }

        return [...selected].flatMap(([model, { entry }]) => {
            // Recovery may retain disabled entries for existing jobs; new selections exclude them.
            if (!includeHidden && (entry.catalog.enabled === false || entry.presentation?.visible === false)) return [];
            return [{
                ...provider,
                id: `${provider.id}::model:${encodeURIComponent(model)}`,
                sourceProviderId: provider.sourceProviderId || provider.id,
                model,
                capability: provider.capability || entry.kind,
                catalogEntryId: entry.id
            }];
        });
    });
}
