import { catalogProviderKinds, getCatalogProviderEntries, isRemoteCatalog } from '../shared/model-catalog.mjs';
import relaySites from '../shared/relay-sites.cjs';
const { SITES } = relaySites;

export function mergeRelayAccount(config, catalog, account) {
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
    for (const capability of kinds) {
        const index = providers.findIndex(provider => provider.relayAccount?.site === account.site
            && provider.relayAccount?.userId === account.userId && provider.capability === capability);
        const previous = providers[index];
        const entries = getCatalogProviderEntries(catalog, { endpoint, capability });
        const preferred = entries.find(entry => entry.catalog.model === previous?.model)
            || entries.find(entry => entry.id === catalog.defaultModels?.[capability]) || entries[0];
        const provider = { ...previous, id: previous?.id || `relay-${account.site}-${account.userId}-${capability}`,
            name: previous?.name || `RavenHash ${SITES[account.site].name}${account.username ? ` · ${account.username}` : ''}`,
            type: 'openai', capability, endpoint, apiKey: account.apiKey, modelCatalog: 'remote',
            model: preferred?.catalog.model || '', models: [],
            relayAccount: { site: account.site, userId: account.userId, tokenId: account.tokenId, username: account.username || '' } };
        if (index >= 0) providers[index] = provider;
        else {
            if (providers.length >= 100 || providers.some(existing => existing.id === provider.id)) throw new Error('API account limit or identity conflict');
            providers.push(provider);
        }
        const key = `${capability}ProviderId`;
        if (globalConfig[key] !== provider.id && !String(globalConfig[key] || '').startsWith(`${provider.id}::model:`)) {
            globalConfig[key] = provider.id;
            if (capability === 'video') globalConfig.videoProviderSelection = 'catalog';
        }
    }
    return { ...config, providers, globalConfig };
}
