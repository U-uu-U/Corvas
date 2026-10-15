import { catalogProviderKinds, expandCatalogProviders, getCatalogProviderEntries, isRemoteCatalog } from '../shared/model-catalog.mjs';
import relaySites from '../shared/relay-sites.cjs';
const { SITES } = relaySites;

export function mergeRelayAccount(config, catalog, account, { selectDefault = true } = {}) {
    if (!Object.hasOwn(SITES, account?.site) || !/^[A-Za-z0-9_-]{1,160}$/.test(account.userId || '')
        || !/^\d+$/.test(account.tokenId || '') || !/^sk-[A-Za-z0-9_-]{8,500}$/.test(account.apiKey || '')) {
        throw new Error('Invalid relay account');
    }
    if (!isRemoteCatalog(catalog)) throw new Error('Remote model catalog unavailable');
    const endpoint = `${SITES[account.site].origin}/v1`;
    const kinds = catalogProviderKinds(catalog, endpoint);
    if (!kinds.length) throw new Error('Remote station models unavailable');
    const providers = [...(config.providers || [])];
    const globalConfig = { ...config.globalConfig };
    let imported = 0;
    for (const capability of kinds) {
        const index = providers.findIndex(provider => provider.relayAccount?.site === account.site
            && provider.relayAccount?.userId === account.userId && provider.relayAccount?.tokenId === account.tokenId
            && provider.capability === capability);
        const previous = providers[index];
        const modelAvailability = Array.isArray(account.modelAvailability?.models) ? account.modelAvailability
            : previous?.apiKey === account.apiKey && previous?.endpoint === endpoint ? previous.modelAvailability : undefined;
        const entries = getCatalogProviderEntries(catalog, { endpoint, capability })
            .filter(entry => !modelAvailability || modelAvailability.models.includes(entry.catalog.model));
        if (modelAvailability && !entries.length) {
            // Keep saved identities for existing nodes, but do not invent another model role for this key.
            if (previous) providers[index] = { ...previous, apiKey: account.apiKey, modelAvailability };
            continue;
        }
        imported++;
        const preferred = entries.find(entry => entry.catalog.model === previous?.model)
            || entries.find(entry => entry.id === catalog.defaultModels?.[capability]) || entries[0];
        const provider = { ...previous, id: previous?.id || `relay-${account.site}-${account.userId}-key-${account.tokenId}-${capability}`,
            name: previous?.name || `${SITES[account.site].name} · ${account.tokenName || account.username || `Key ${account.tokenId}`}`,
            type: 'openai', capability, endpoint, apiKey: account.apiKey, modelCatalog: 'remote',
            modelAvailability,
            model: preferred?.catalog.model || '', models: [],
            relayAccount: { site: account.site, userId: account.userId, tokenId: account.tokenId,
                tokenName: account.tokenName || '', username: account.username || '' } };
        if (index >= 0) providers[index] = provider;
        else {
            if (providers.length >= 100 || providers.some(existing => existing.id === provider.id)) throw new Error('API account limit or identity conflict');
            providers.push(provider);
        }
        const key = `${capability}ProviderId`;
        const currentAvailable = expandCatalogProviders(catalog, providers, { includeHidden: true })
            .some(option => option.id === globalConfig[key] || option.sourceProviderId === globalConfig[key]);
        if ((selectDefault || !currentAvailable) && (!currentAvailable
            || globalConfig[key] !== provider.id && !String(globalConfig[key] || '').startsWith(`${provider.id}::model:`))) {
            globalConfig[key] = provider.id;
            if (capability === 'video') globalConfig.videoProviderSelection = 'catalog';
        }
    }
    if (!imported) throw new Error('所选 API Key 在当前模型目录中没有可用模型，请选择其他 Key');
    return { ...config, providers, globalConfig };
}

export function mergeRelayAccounts(config, catalog, accounts) {
    if (!Array.isArray(accounts) || !accounts.length || accounts.length > 100) throw new Error('Invalid relay account selection');
    return accounts.reduce((next, account, index) => mergeRelayAccount(next, catalog, account, { selectDefault: index === 0 }), config);
}
