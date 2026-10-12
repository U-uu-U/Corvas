import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRelayAccount, mergeRelayAccounts } from './relay-account-config.js';

const catalog = { catalogMode: 'remote', defaultModels: { video: 'second' }, models: ['first', 'second'].map(model => ({
    id: model, kind: 'video', catalog: { model, hosts: ['art.ravenhash.org', 'cart.ravenhash.org'] }
})) };
const account = { site: 'art', userId: 'user1', username: 'Fixture', tokenId: '1', apiKey: 'sk-fixtureOnly123' };

test('login imports the correct station and CONFIG models without changing unrelated API accounts', () => {
    const config = { providers: [{ id: 'custom', apiKey: 'keep', endpoint: 'https://example.test' }], globalConfig: { custom: true } };
    const original = structuredClone(config);
    const linked = mergeRelayAccount(config, catalog, account);
    assert.deepEqual(config, original);
    assert.deepEqual(linked.providers[0], config.providers[0]);
    assert.equal(linked.providers[1].endpoint, 'https://art.ravenhash.org/v1');
    assert.equal(linked.providers[1].model, 'second');
    assert.equal(linked.providers[1].modelCatalog, 'remote');
    assert.equal(linked.globalConfig.videoProviderId, linked.providers[1].id);
    assert.equal(linked.globalConfig.custom, true);
});

test('reconnection updates the same account and preserves its manual model selection', () => {
    const config = mergeRelayAccount({}, catalog, account);
    config.providers[0].name = 'My account';
    config.globalConfig.videoProviderId += '::model:first';
    config.globalConfig.videoProviderSelection = 'manual';
    const updated = mergeRelayAccount(config, catalog, { ...account, apiKey: 'sk-newFixtureOnly123' });
    assert.equal(updated.providers.length, 1);
    assert.equal(updated.providers[0].name, 'My account');
    assert.equal(updated.providers[0].apiKey, 'sk-newFixtureOnly123');
    assert.deepEqual(updated.globalConfig, config.globalConfig);
});

test('site and account switches preserve old providers used by existing tasks', () => {
    const first = mergeRelayAccount({}, catalog, account);
    const second = mergeRelayAccount(first, catalog, { ...account, site: 'cart' });
    const third = mergeRelayAccount(second, catalog, { ...account, userId: 'user2' });
    assert.equal(third.providers.length, 3);
    assert.deepEqual(third.providers[0], first.providers[0]);
    assert.equal(third.providers[1].endpoint, 'https://cart.ravenhash.org/v1');
    assert.equal(third.globalConfig.videoProviderId, third.providers[2].id);
});

test('no arbitrary host, missing catalog or malformed credential is imported', () => {
    for (const invalid of [{ site: 'other' }, { userId: '../other' }, { tokenId: 'oops' }, { apiKey: 'masked***' }]) {
        assert.throws(() => mergeRelayAccount({}, catalog, { ...account, ...invalid }));
    }
    assert.throws(() => mergeRelayAccount({}, { models: [] }, account));
    assert.throws(() => mergeRelayAccount({}, { catalogMode: 'remote', models: [] }, account));
});

test('image login creates only the model roles actually published for the image station', () => {
    const imageCatalog = { catalogMode: 'remote', models: [{ id: 'image', kind: 'image',
        catalog: { model: 'image-model', hosts: ['ai.ravenhash.org'] } }] };
    const linked = mergeRelayAccount({}, imageCatalog, { ...account, site: 'ai' });
    assert.equal(linked.providers.length, 1);
    assert.equal(linked.providers[0].capability, 'image');
    assert.equal(linked.providers[0].endpoint, 'https://ai.ravenhash.org/v1');
    assert.equal(linked.globalConfig.imageProviderId, linked.providers[0].id);
    assert.equal(linked.globalConfig.videoProviderId, undefined);
});

test('multiple keys have separate providers and reimport preserves legacy IDs and bindings', () => {
    const first = mergeRelayAccount({}, catalog, account);
    first.providers[0].id = 'legacy-provider-id';
    first.globalConfig.videoProviderId = 'legacy-provider-id::model:first';
    const second = { ...account, tokenId: '2', tokenName: 'Second Key', apiKey: 'sk-secondFixture123' };
    const config = mergeRelayAccounts(first, catalog, [account, second]);
    assert.equal(config.providers.length, 2);
    assert.equal(config.providers[0].id, 'legacy-provider-id');
    assert.notEqual(config.providers[0].id, config.providers[1].id);
    assert.ok(config.providers[1].name.includes('Second Key'));
    assert.equal(config.globalConfig.videoProviderId, 'legacy-provider-id::model:first');
    const again = mergeRelayAccounts(config, catalog, [account, second]);
    assert.deepEqual(again, config);
    assert.throws(() => mergeRelayAccounts(config, catalog, [account, { ...second, apiKey: 'bad' }]));
    assert.equal(config.providers[1].apiKey, 'sk-secondFixture123');
});
