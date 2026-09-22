import test from 'node:test';
import assert from 'node:assert/strict';
import { expandCatalogProviders, findCatalogEntry, isRemoteCatalog, isCatalogManaged,
    getCatalogProviderEntries, catalogProviderKinds } from './model-catalog.mjs';

const account = { id: 'video-account', endpoint: 'https://art.example.test/v1', apiKey: 'test-art-key',
    capability: 'video', model: 'local-old', models: ['local-old', 'local-extra'] };
const entry = (id = 'remote-a', overrides = {}) => ({ id, kind: 'video', priority: 0,
    catalog: { model: id, hosts: ['art.example.test'] }, ...overrides });
const remote = (...models) => ({ catalogMode: 'remote', models });

test('new remote accounts use URL and capability without a local model list or global scope change', () => {
    const config = { ...remote(entry('remote-video'), entry('remote-image', { kind: 'image' }),
        entry('other-host', { kind: 'image', catalog: { model: 'other-host', hosts: ['other.test'] } })),
    catalogScope: { hosts: ['art.example.test'], kinds: ['video'] } };
    const imageAccount = { ...account, capability: 'image', modelCatalog: 'remote', model: 'remote-image', models: [] };
    const oldImageAccount = { ...imageAccount, id: 'old-image', modelCatalog: undefined, model: 'custom-image', models: ['custom-image'] };
    const oldTextAccount = { ...oldImageAccount, id: 'old-text', capability: 'text', model: 'custom-text', models: ['custom-text'] };
    const before = structuredClone(config);

    assert.deepEqual(getCatalogProviderEntries(config, { endpoint: imageAccount.endpoint, capability: 'image' })
        .map(model => model.id), ['remote-image']);
    const expanded = expandCatalogProviders(config, [imageAccount, oldImageAccount, oldTextAccount]);
    assert.deepEqual(expanded.map(model => [model.id, model.model]), [
        ['video-account::model:remote-image', 'remote-image'], ['old-image', 'custom-image'], ['old-text', 'custom-text']
    ]);
    assert.equal(findCatalogEntry(config, expanded[0]).id, 'remote-image');
    assert.deepEqual(config, before);
    config.models.push(entry('new-image', { kind: 'image' }));
    assert.deepEqual(expandCatalogProviders(config, [imageAccount]).map(model => model.model), ['remote-image', 'new-image']);
    config.models = [];
    assert.deepEqual(expandCatalogProviders(config, [imageAccount]), []);
    assert.equal(isCatalogManaged(config, imageAccount), true);
});

test('explicit remote accounts never restore local models when remote config is unavailable', () => {
    const provider = { ...account, modelCatalog: 'remote' };
    for (const config of [undefined, {}, { models: [entry('local-old')] },
        { catalogMode: 'legacy', models: [entry('local-old')] }, remote()]) {
        assert.equal(isCatalogManaged(config, provider), true);
        assert.deepEqual(getCatalogProviderEntries(config, provider), []);
        assert.deepEqual(expandCatalogProviders(config, [provider]), []);
        assert.equal(findCatalogEntry(config, provider), null);
    }
});

test('form catalog helpers share exact host, kind, priority and visibility rules with expansion', () => {
    const low = entry('low', { catalog: { model: 'same', hosts: ['art.example.test'] }, priority: 1 });
    const high = entry('high', { catalog: { model: 'same', hosts: ['art.example.test'], enabled: false }, priority: 2 });
    const hidden = entry('hidden', { presentation: { visible: false } });
    const config = remote(low, high, hidden, entry('image', { kind: 'image' }), entry('visible'));
    assert.deepEqual(getCatalogProviderEntries(config, account).map(model => model.id), ['visible']);
    assert.deepEqual(getCatalogProviderEntries(config, account, { includeHidden: true }).map(model => model.id),
        ['high', 'hidden', 'visible']);
    assert.deepEqual(catalogProviderKinds(config, 'https://ART.EXAMPLE.TEST:8443/v1'), ['video', 'image']);
    assert.deepEqual(catalogProviderKinds(remote(high, hidden), account.endpoint), ['video']);
    for (const endpoint of ['https://art.example.test.evil.test/v1', 'https://sub.art.example.test/v1',
        'https://user@art.example.test/v1', 'file:///art.example.test', '']) {
        assert.deepEqual(getCatalogProviderEntries(config, { ...account, endpoint }), []);
        assert.deepEqual(catalogProviderKinds(config, endpoint), []);
    }
    assert.deepEqual(catalogProviderKinds({ models: config.models }, account.endpoint), []);
});

test('scoped catalogs retain text, image and custom accounts while an empty managed directory stays empty', () => {
    const config = { ...remote(), catalogScope: { hosts: ['art.example.test'], kinds: ['video'] } };
    const accounts = [account,
        { ...account, id: 'text', capability: 'text', model: 'gpt-5', models: ['gpt-5', 'claude-sonnet'] },
        { ...account, id: 'image', capability: 'image', model: 'gpt-image-2', models: ['gpt-image-2'] },
        { ...account, id: 'custom', endpoint: 'https://custom.test/v1' }];
    const before = structuredClone(accounts);
    const expanded = expandCatalogProviders(config, accounts);
    assert.deepEqual(expanded.map(p => [p.id, p.model]), [
        ['text', 'gpt-5'], ['text::model:claude-sonnet', 'claude-sonnet'], ['image', 'gpt-image-2'],
        ['custom', 'local-old'], ['custom::model:local-extra', 'local-extra']
    ]);
    assert.deepEqual(accounts, before);
    assert.equal(isCatalogManaged(config, account), true);
    assert.equal(isCatalogManaged(config, accounts[1]), false);
    config.models = [entry('gpt-5', { kind: 'text' })];
    assert.equal(findCatalogEntry(config, accounts[1]), null);
});

test('scope matches exact validated hosts and infers undeclared kinds from exact catalog models only', () => {
    const config = { ...remote(entry('opaque-model')), catalogScope: { hosts: ['art.example.test'], kinds: ['video'] } };
    const undeclared = { ...account, capability: undefined, model: 'opaque-model' };
    assert.equal(isCatalogManaged(config, undeclared), true);
    assert.equal(expandCatalogProviders(config, [undeclared])[0].capability, 'video');
    assert.equal(isCatalogManaged(config, { ...undeclared, model: 'gpt-5' }), false);
    assert.equal(isCatalogManaged(config, { ...undeclared, model: 'gpt-5', name: 'video planning' }), false);
    assert.equal(isCatalogManaged(config, { ...undeclared, capability: 'text' }), false);
    for (const host of ['*.example.test', 'https://art.example.test', 'art.example.test:443', 'art.example.test/path']) {
        assert.equal(isCatalogManaged({ ...config, catalogScope: { ...config.catalogScope, hosts: [host] } }, account), false);
    }
    for (const endpoint of ['https://art.example.test.evil.test/v1', 'https://sub.art.example.test/v1',
        'https://user@art.example.test/v1', 'file:///art.example.test']) {
        assert.equal(isCatalogManaged(config, { ...account, endpoint }), false);
    }
    assert.equal(isCatalogManaged(config, { ...account, endpoint: 'https://ART.EXAMPLE.TEST:8443/v1' }), true);
});

test('remote mode is explicit and an empty directory never restores local models', () => {
    assert.equal(isRemoteCatalog(remote()), true);
    for (const config of [undefined, {}, { catalogMode: 'legacy' }, { catalogMode: 'Remote' }]) {
        assert.equal(isRemoteCatalog(config), false);
    }
    for (const config of [remote(), { catalogMode: 'remote' }, remote(null, {})]) {
        assert.deepEqual(expandCatalogProviders(config, [account]), []);
    }
    assert.deepEqual(expandCatalogProviders(remote(entry()), undefined), []);
});

test('remote additions and removals follow explicit catalog models without local supplementation', () => {
    const config = remote(entry('remote-a'), entry('remote-b'));
    const before = structuredClone({ config, account });
    const expanded = expandCatalogProviders(config, [account]);
    assert.deepEqual(expanded.map(provider => provider.model), ['remote-a', 'remote-b']);
    assert.deepEqual(expanded.map(provider => provider.catalogEntryId), ['remote-a', 'remote-b']);
    assert.deepEqual({ config, account }, before);
    config.models.splice(0, 1);
    assert.deepEqual(expandCatalogProviders(config, [account]).map(provider => provider.model), ['remote-b']);
    config.models.push(entry('remote-c'));
    assert.deepEqual(expandCatalogProviders(config, [account]).map(provider => provider.model), ['remote-b', 'remote-c']);
});

test('credentials and endpoints stay bound to exact hostnames and accounts', () => {
    const cart = { ...account, id: 'cart-account', endpoint: 'https://cart.example.test:8443/v1', apiKey: 'test-cart-key' };
    const config = remote(entry('art-model'), entry('cart-model', {
        catalog: { model: 'cart-model', hosts: ['cart.example.test'] }
    }));
    const [artProvider, cartProvider] = expandCatalogProviders(config, [account, cart]);
    assert.equal(artProvider.apiKey, account.apiKey);
    assert.equal(artProvider.endpoint, account.endpoint);
    assert.equal(artProvider.sourceProviderId, account.id);
    assert.equal(artProvider.model, 'art-model');
    assert.equal(cartProvider.apiKey, cart.apiKey);
    assert.equal(cartProvider.endpoint, cart.endpoint);
    assert.equal(cartProvider.sourceProviderId, cart.id);
    assert.equal(cartProvider.model, 'cart-model');
    const explicitSource = { ...account, sourceProviderId: 'source-account' };
    assert.equal(expandCatalogProviders(config, [explicitSource])[0].sourceProviderId, 'source-account');
    assert.equal(expandCatalogProviders(config, [{ ...account, endpoint: 'https://ART.EXAMPLE.TEST/v1' }]).length, 1);
});

test('unknown hosts, malformed endpoints, host wildcards and missing explicit models are rejected', () => {
    for (const endpoint of ['https://unknown.test/v1', 'https://art.example.test.evil.test/v1',
        'https://evil.test/art.example.test', 'https://art.example.test@evil.test/v1',
        'ftp://art.example.test/v1', 'art.example.test', '', undefined]) {
        assert.deepEqual(expandCatalogProviders(remote(entry()), [{ ...account, endpoint }]), [], String(endpoint));
    }
    for (const host of ['*', '*.example.test', 'https://art.example.test', 'art.example.test/v1',
        'art.example.test:443', 'art.example.test?other', '', null]) {
        const config = remote(entry('remote-a', { catalog: { model: 'remote-a', hosts: [host] } }));
        assert.deepEqual(expandCatalogProviders(config, [account]), [], String(host));
    }
    for (const model of ['', '   ', undefined, 42]) {
        const config = remote(entry('remote-a', { catalog: { model, hosts: ['art.example.test'] } }));
        assert.deepEqual(expandCatalogProviders(config, [account]), []);
    }
    assert.deepEqual(expandCatalogProviders(remote({ id: 'guess-me', kind: 'video',
        label: 'remote-a', match: { model: '^remote-a$' } }), [account]), []);
});

test('model identity remains stable through additions and reordering', () => {
    const first = entry('entry-a', { catalog: { model: 'model/a b', hosts: ['art.example.test'] } });
    const second = entry('entry-b');
    const initial = expandCatalogProviders(remote(first, second), [account]);
    const reordered = expandCatalogProviders(remote(entry('new'), second, first), [account]);
    for (const provider of initial) {
        assert.equal(reordered.find(candidate => candidate.model === provider.model).id, provider.id);
        assert.equal(provider.id, `${account.id}::model:${encodeURIComponent(provider.model)}`);
    }
});

test('explicit account capability must match; undeclared capability comes only from the entry kind', () => {
    const imageEntry = entry('remote-image', { kind: 'image' });
    assert.deepEqual(expandCatalogProviders(remote(imageEntry), [account]), []);
    const undeclared = { ...account, capability: undefined, model: 'text-local-model' };
    const providers = expandCatalogProviders(remote(entry(), imageEntry), [undeclared]);
    assert.deepEqual(providers.map(provider => provider.capability), ['video', 'image']);
    assert.deepEqual(expandCatalogProviders(remote(entry('invalid-kind', { kind: 'other' })), [undeclared]), []);
});

test('hidden and disabled models are excluded from selection but retain bindings for recovery', () => {
    const hidden = entry('hidden', { presentation: { visible: false } });
    const disabled = entry('disabled', { catalog: { model: 'disabled', hosts: ['art.example.test'], enabled: false } });
    const config = remote(entry('visible'), hidden, disabled);
    assert.deepEqual(expandCatalogProviders(config, [account]).map(provider => provider.model), ['visible']);
    assert.deepEqual(expandCatalogProviders(config, [account], { includeHidden: true }).map(provider => provider.model),
        ['visible', 'hidden', 'disabled']);
});

test('duplicate wire models use the highest priority entry on each account', () => {
    const low = entry('low', { priority: 1, catalog: { model: 'same', hosts: ['art.example.test'] } });
    const high = entry('high', { priority: 10, catalog: { model: 'same', hosts: ['art.example.test'] } });
    for (const config of [remote(low, high), remote(high, low)]) {
        const providers = expandCatalogProviders(config, [account, { ...account, id: 'second-account' }]);
        assert.equal(providers.length, 2);
        assert.deepEqual(providers.map(provider => provider.catalogEntryId), ['high', 'high']);
    }
    const disabledHigh = { ...high, catalog: { ...high.catalog, enabled: false } };
    assert.deepEqual(expandCatalogProviders(remote(low, disabledHigh), [account]), []);
    assert.equal(expandCatalogProviders(remote(low, disabledHigh), [account], { includeHidden: true })[0].catalogEntryId, 'high');
});

test('legacy expansion retains first-model IDs, trimming, deduplication and explicit empty lists', () => {
    const providers = [{ ...account, models: [' first ', 'second', 'first', '', null] },
        { id: 'single', model: ' only ', endpoint: 'legacy-endpoint' },
        { id: 'empty', models: [], model: 'ignored' }];
    for (const config of [undefined, {}, { catalogMode: 'legacy', models: [] }]) {
        const expanded = expandCatalogProviders(config, providers);
        assert.deepEqual(expanded.map(provider => [provider.id, provider.model, provider.sourceProviderId]), [
            [account.id, 'first', account.id],
            [`${account.id}::model:second`, 'second', account.id],
            ['single', 'only', 'single']
        ]);
        assert.equal(expanded[0].apiKey, account.apiKey);
        assert.equal(expanded[0].catalogEntryId, undefined);
    }
});

test('catalog lookup uses exact model, hostname and explicit kinds without regex fallback', () => {
    const model = entry('remote-a');
    const config = remote(model);
    const provider = { ...account, model: 'remote-a' };
    assert.equal(findCatalogEntry(config, provider), model);
    assert.equal(findCatalogEntry(config, { ...provider, kind: 'video' }), model);
    for (const overrides of [{ model: 'remote-b' }, { endpoint: 'https://cart.example.test/v1' },
        { endpoint: 'bad-url' }, { kind: 'image' }, { capability: 'text' }, { model: '' }]) {
        assert.equal(findCatalogEntry(config, { ...provider, ...overrides }), null);
    }
    assert.equal(findCatalogEntry(config, null), null);
    assert.equal(findCatalogEntry({ models: [model] }, provider), null);
    assert.equal(findCatalogEntry(remote({ id: 'regex', kind: 'video', match: { model: '^remote-a$' } }), provider), null);
});

test('catalog lookup retains disabled metadata and prefers a valid explicit entry over priority', () => {
    const low = entry('low', { priority: 1, presentation: { visible: false },
        catalog: { model: 'same', hosts: ['art.example.test'], enabled: false } });
    const high = entry('high', { priority: 10, catalog: { model: 'same', hosts: ['art.example.test'] } });
    const otherHost = entry('other-host', { priority: 100, catalog: { model: 'same', hosts: ['cart.example.test'] } });
    const otherModel = entry('other-model');
    const config = remote(low, high, otherHost, otherModel);
    const provider = { ...account, model: 'same' };
    assert.equal(findCatalogEntry(config, provider), high);
    assert.equal(findCatalogEntry(config, { ...provider, catalogEntryId: 'low' }), low);
    assert.equal(findCatalogEntry(config, { ...provider, catalogEntryId: 'other-host' }), high);
    assert.equal(findCatalogEntry(config, { ...provider, catalogEntryId: 'other-model' }), high);
});
