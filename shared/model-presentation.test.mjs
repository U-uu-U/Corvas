import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv from 'ajv';
import { getModelPresentation, formatModelPrice, describeModelPresentation } from './model-presentation.mjs';
import { getVideoModelProfile, describeVideoModelProfile } from './video-model-profiles.mjs';
import { resolveModelConfigEntry, toVideoProfileOverrides, mergeVideoProfile } from '../src/model-config-capabilities.js';
import { DEFAULT_MODEL_CONFIG } from '../src/model-config-default.js';
import { createModelConfigStore } from '../src/model-config.js';

const schema = JSON.parse(fs.readFileSync(new URL('./schemas/model-config.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true }).compile(schema);
const provider = { model: 'sd2.5-route1', endpoint: 'https://art.ravenhash.org/v1', kind: 'video' };
const entryFor = (config, p = provider) => resolveModelConfigEntry(config, p).entry;
const profileFor = (config, p = provider) => mergeVideoProfile(getVideoModelProfile(p), toVideoProfileOverrides(config, entryFor(config, p), p));
const sale = { status: 'known', hosts: ['art.ravenhash.org'], amount: 6.5, currency: 'CNY', unit: 'request',
    kind: 'sale', source: 'test-sale-catalog', updatedAt: '2026-09-13T00:00:00Z' };

test('remote presentation replaces display fields without changing capabilities or provider identity', () => {
    const config = structuredClone(DEFAULT_MODEL_CONFIG);
    const before = structuredClone(provider);
    Object.assign(entryFor(config), {
        presentation: { label: 'Remote model', description: 'Remote description', routeLabel: 'Route A',
            routeGroup: 'new-group', routeGroupLabel: 'Remote routes', routeModelLabel: 'Model A', recommended: false },
        pricing: sale
    });
    const profile = profileFor(config);
    assert.equal(profile.label, 'Remote model');
    assert.equal(profile.routeLabel, 'Route A');
    assert.equal(profile.routeGroup, 'new-group');
    assert.equal(profile.recommended, false);
    assert.equal(profile.price.amount, 6.5);
    assert.equal(profile.price.currency, 'CNY');
    assert.deepEqual(profile.durations, [30]);
    assert.deepEqual(profile.referenceLimits, profileFor(DEFAULT_MODEL_CONFIG).referenceLimits);
    assert.equal(describeVideoModelProfile(profile), 'Remote description；¥6.5/次');
    assert.deepEqual(provider, before);
});

test('old documents retain local names, routes and scoped sale prices', () => {
    const config = structuredClone(DEFAULT_MODEL_CONFIG);
    for (const entry of config.models) { delete entry.presentation; delete entry.pricing; }
    const profile = profileFor(config);
    assert.equal(profile.label, 'Seedance 2.5');
    assert.equal(profile.routeLabel, '线路一');
    assert.equal(profile.recommended, true);
    assert.equal(profile.price.amount, 6);
    assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test('prices match exact hostnames, not URL substrings or unrelated channels', () => {
    const entry = { pricing: sale };
    for (const endpoint of ['https://other.test/v1', 'https://art.ravenhash.org.evil.test/v1',
        'https://evil.test/art.ravenhash.org', 'https://art.ravenhash.org@evil.test/v1', '', undefined]) {
        assert.equal(getModelPresentation(entry, { endpoint }).price, undefined, endpoint);
    }
    assert.equal(getModelPresentation(entry, { endpoint: 'https://ART.RAVENHASH.ORG/v1/videos' }).price.amount, 6.5);
    assert.equal(getModelPresentation({ pricing: { ...sale, kind: 'cost' } }, provider).price, undefined);
    assert.equal(getModelPresentation({ pricing: { ...sale, hosts: 'art.ravenhash.org' } }, provider).price, undefined);
});

test('unknown price clears the old sale; explicit empty route fields ungroup a model', () => {
    const config = structuredClone(DEFAULT_MODEL_CONFIG);
    entryFor(config).pricing = { status: 'unknown', hosts: sale.hosts };
    entryFor(config).presentation = { routeLabel: '', routeGroup: '', description: '' };
    const profile = profileFor(config);
    assert.equal(profile.price, null);
    assert.equal(profile.routeGroup, '');
    assert.equal(profile.routeLabel, '');
    assert.equal(describeVideoModelProfile(profile), '费用未知');
    assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test('remote grouping preserves explicit zero, false and provider scope over local defaults', () => {
    const defaults = { routeGroupDescription: 'Default group', routeGroupOrder: 20, routeOrder: 5,
        routeGroupAlways: true, routeGroupScope: 'catalog', visible: true };
    const overrides = { routeGroupDescription: '', routeGroupOrder: 0, routeOrder: -10,
        routeGroupAlways: false, routeGroupScope: 'provider', visible: false };
    const projected = getModelPresentation({ presentation: overrides });
    assert.deepEqual(projected, overrides);
    assert.deepEqual(mergeVideoProfile(defaults, projected), { ...overrides, referenceLimits: {} });
    assert.deepEqual(getModelPresentation({ presentation: {} }), {});
    assert.deepEqual(getModelPresentation({ presentation: {
        routeGroupOrder: '0', routeOrder: 1.5, routeGroupAlways: 'false', routeGroupScope: '', visible: 'false'
    } }), {});
});

test('client and server schemas accept grouping metadata and reject invalid presentation types', () => {
    const serverSchema = JSON.parse(fs.readFileSync(new URL('../configserver/schema/model-config.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(serverSchema, schema);
    const config = structuredClone(DEFAULT_MODEL_CONFIG);
    const selected = entryFor(config);
    selected.presentation = { routeGroupDescription: 'x'.repeat(500), routeGroupOrder: -100000,
        routeOrder: 100000, routeGroupAlways: false, routeGroupScope: 'provider', visible: false };
    assert.equal(validate(config), true, JSON.stringify(validate.errors));
    const valid = structuredClone(selected.presentation);
    for (const invalid of [{ routeGroupDescription: 'x'.repeat(501) }, { routeGroupOrder: -100001 },
        { routeOrder: 100001 }, { routeOrder: 0.5 }, { routeOrder: '0' }, { routeGroupAlways: 'false' },
        { routeGroupScope: 'all' }, { routeGroupScope: '' }, { visible: 0 }]) {
        selected.presentation = { ...valid, ...invalid };
        assert.equal(validate(config), false, JSON.stringify(invalid));
    }
});

test('currency and billing units are explicit, zero is not an unknown price', () => {
    assert.equal(formatModelPrice(sale), '¥6.5/次');
    assert.equal(formatModelPrice({ ...sale, currency: 'USD' }), 'US$6.5/次');
    assert.equal(formatModelPrice({ ...sale, amount: 0, unit: 'image' }), '¥0/张');
    assert.equal(formatModelPrice({ ...sale, amount: 0.05, unit: 'second' }), '¥0.05/秒');
    assert.equal(formatModelPrice({ ...sale, amount: -1 }), '');
    assert.equal(formatModelPrice({ ...sale, amount: '5' }), '');
    assert.equal(formatModelPrice({ ...sale, kind: 'cost' }), '');
    assert.equal(formatModelPrice(null), '费用未知');
    assert.equal(formatModelPrice(undefined), '');
});

test('image and text display metadata use the same projection without exposing extra fields', () => {
    for (const kind of ['image', 'text']) {
        const entry = { kind, pricing: sale, presentation: { label: `${kind} label`, description: 'Example', endpoint: 'bad' } };
        const profile = getModelPresentation(entry, provider);
        assert.equal(profile.label, `${kind} label`);
        assert.equal(profile.endpoint, undefined);
        assert.equal(describeModelPresentation(profile), 'Example；¥6.5/次');
    }
});

test('canvas descriptions omit sale and unknown prices without changing structured pricing', () => {
    for (const price of [sale, null]) {
        const profile = { description: '720p；4-30 秒', price };
        const before = structuredClone(profile);
        assert.equal(describeModelPresentation(profile, '', { includePrice: false }), '720p；4-30 秒');
        assert.equal(describeVideoModelProfile(profile, { includePrice: false }), '720p；4-30 秒');
        assert.deepEqual(profile, before);
        assert.equal(describeModelPresentation({ price }, 'Model details', { includePrice: false }), 'Model details');
        assert.equal(describeVideoModelProfile({ price, resolutions: ['720p'], durations: [30] }, { includePrice: false }),
            '720p；固定 30 秒');
    }
});

test('schema rejects malformed prices, missing scope, costs and unexpected display fields', () => {
    const invalid = [
        { pricing: { ...sale, currency: 'RMB' } }, { pricing: { ...sale, amount: -1 } },
        { pricing: { ...sale, kind: 'cost' } }, { pricing: { ...sale, hosts: [] } },
        { pricing: { ...sale, hosts: ['*.ravenhash.org'] } }, { pricing: { ...sale, unit: 'token' } },
        { pricing: { ...sale, updatedAt: 'yesterday' } }, { pricing: { ...sale, source: ' ' } },
        { presentation: { label: ' ' } }, { presentation: { label: 'x', apiKey: 'must-not-be-here' } }
    ];
    for (const fields of invalid) {
        const config = structuredClone(DEFAULT_MODEL_CONFIG);
        Object.assign(entryFor(config), fields);
        assert.equal(validate(config), false, JSON.stringify(fields));
    }
    assert.equal(validate(DEFAULT_MODEL_CONFIG), true, JSON.stringify(validate.errors));
});

test('route two alias resolves to the same fixed-duration config and current prices stay unchanged', () => {
    for (const [model, amount] of [['sd2.5-route1', 6], ['sd2.5-route2', 6], ['sd2.5', 6],
        ['sd2.5-haidiyue-face', 6], ['seedance_v2.5', 5], ['seedance_v2.0-933', 6.5],
        ['seedance_v2.5-101010', 7], ['seedance_v2.5-301010', 10]]) {
        const p = { ...provider, model };
        assert.ok(entryFor(DEFAULT_MODEL_CONFIG, p), model);
        assert.equal(profileFor(DEFAULT_MODEL_CONFIG, p).price.amount, amount, model);
        assert.equal(profileFor(DEFAULT_MODEL_CONFIG, p).price.currency, 'CNY', model);
    }
    assert.deepEqual(profileFor(DEFAULT_MODEL_CONFIG, { ...provider, model: 'sd2.5-route2' }).durations, [30]);
});

test('refresh, failed validation, cache restart and rollback retain usable presentation', async t => {
    const cache = new Map();
    const storage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) };
    let remote = structuredClone(DEFAULT_MODEL_CONFIG);
    remote.revision = 20;
    entryFor(remote).presentation.description = 'Remote description';
    entryFor(remote).pricing = sale;
    const store = createModelConfigStore({ storage, url: 'https://config.test/config',
        loadRemote: async () => validate(remote) ? { ok: true, raw: remote } : { ok: false, error: 'invalid schema' } });
    t.after(() => store.stop());
    assert.equal((await store.refresh({ force: true })).ok, true);
    assert.equal(profileFor(store.getConfig()).price.amount, 6.5);
    const restarted = createModelConfigStore({ storage, url: 'https://config.test/config' });
    t.after(() => restarted.stop());
    restarted.start({ refreshOnStart: false });
    assert.equal(profileFor(restarted.getConfig()).description, 'Remote description');
    remote = structuredClone(remote);
    entryFor(remote).pricing.currency = 'RMB';
    assert.equal((await store.refresh({ force: true })).ok, false);
    assert.equal(profileFor(store.getConfig()).price.amount, 6.5);
    remote = structuredClone(DEFAULT_MODEL_CONFIG);
    assert.equal((await store.refresh({ force: true })).ok, true);
    assert.equal(profileFor(store.getConfig()).price.amount, 6);
    assert.equal(profileFor(store.getConfig()).description, undefined);
});
