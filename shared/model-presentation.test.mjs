import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv from 'ajv';
import { getModelPresentation, formatModelPrice, describeModelPresentation,
    formatModelSalePrice, formatModelSalePriceDetails } from './model-presentation.mjs';
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
const siteSale = (host = 'art.ravenhash.org', amount = 5, unit = 'request') => ({
    host, status: 'known', currency: 'CNY', kind: 'sale', source: 'relay billing snapshot',
    updatedAt: '2026-09-24T00:00:00.000Z', prices: [{ label: '', amount, unit }]
});

test('sale price projection uses the exact provider host and supersedes legacy prices', () => {
    const art = siteSale();
    const cart = siteSale('cart.ravenhash.org', 5.72);
    const entry = { salePrices: [art, cart], pricing: sale };
    for (const [endpoint, expected] of [['https://art.ravenhash.org/v1', art], ['https://CART.RAVENHASH.ORG/v1', cart]]) {
        const result = getModelPresentation(entry, { endpoint });
        assert.deepEqual(result.salePricing, expected);
        assert.equal(result.price.amount, expected.prices[0].amount);
        assert.equal(result.price.source, 'relay billing snapshot');
    }
    for (const endpoint of ['https://other.test/v1', 'https://art.ravenhash.org.evil.test/v1',
        'https://evil.test/art.ravenhash.org', 'https://art.ravenhash.org@evil.test/v1', '', undefined]) {
        assert.deepEqual(getModelPresentation(entry, { endpoint }), { salePricing: null, price: null });
    }
    const missing = getModelPresentation({ salePrices: [cart], pricing: sale }, provider);
    assert.deepEqual(missing, { salePricing: null, price: null });
    assert.equal(getModelPresentation({ pricing: sale }, provider).price.amount, sale.amount);
});

test('invalid or duplicate site sale records never revive stale sale amounts', () => {
    const good = siteSale();
    const invalid = [
        [], null, 'invalid', [good, { ...good, prices: [{ label: '', amount: 8, unit: 'request' }] }],
        [{ ...good, host: undefined }], [{ ...good, currency: 'RMB' }], [{ ...good, kind: 'cost' }],
        [{ ...good, updatedAt: '2026-09-24' }], [{ ...good, source: '' }], [{ ...good, prices: [] }],
        [{ ...good, prices: [{ label: '', amount: -1, unit: 'request' }] }],
        [{ ...good, prices: [{ label: '', amount: 5, unit: 'token' }] }], [{ ...good, cost: 1 }]
    ];
    for (const salePrices of invalid) {
        const result = getModelPresentation({ salePrices, pricing: sale }, provider);
        assert.deepEqual(result, { salePricing: null, price: null }, JSON.stringify(salePrices));
        assert.equal(formatModelSalePrice(result.salePricing), '售价待配置');
    }
    const unknown = { ...good, status: 'unknown', prices: [], note: '尚无计费规则' };
    const result = getModelPresentation({ salePrices: [unknown], pricing: sale }, provider);
    assert.equal(result.price, null);
    assert.equal(formatModelSalePrice(result.salePricing), '售价待配置');
    assert.equal(formatModelSalePriceDetails(result.salePricing), '老站售价\n售价待配置\n尚无计费规则');
    assert.equal(formatModelSalePriceDetails(result.salePricing, { includeSite: false }), '售价明细\n售价待配置\n尚无计费规则');
    assert.equal(formatModelSalePrice(undefined), '售价待配置');
});

test('sale formatting preserves zero, currency and billing unit with two decimals', () => {
    assert.equal(formatModelSalePrice(siteSale()), '¥5.00/次');
    assert.equal(formatModelSalePrice(siteSale('cart.ravenhash.org', 1.25, 'second')), '¥1.25/秒');
    assert.equal(formatModelSalePrice(siteSale('art.ravenhash.org', 0, 'image')), '¥0.00/张');
    assert.equal(formatModelSalePrice({ ...siteSale(), currency: 'USD' }), 'US$5.00/次');
    assert.equal(formatModelSalePrice(siteSale('art.ravenhash.org', 46.368, 'million_tokens')), '¥46.37/百万 Token');
    assert.equal(formatModelSalePrice({ ...siteSale(), kind: 'cost' }), '售价待配置');
});

test('tiered resolution prices retain their range until matching resolution is selected', () => {
    const pricing = { ...siteSale(), prices: [
        { label: '480p', amount: 0.05, unit: 'second' },
        { label: '786p', amount: 0.12, unit: 'second' },
        { label: '1080p', amount: 0.20, unit: 'second' },
        { label: '2k超分', amount: 0.20, unit: 'second' },
        { label: '4K', amount: 0.25, unit: 'second' }
    ] };
    assert.equal(formatModelSalePrice(pricing), '¥0.05-0.25/秒');
    assert.equal(formatModelSalePrice(pricing, { resolution: '768p' }), '¥0.12/秒');
    assert.equal(formatModelSalePrice(pricing, { resolution: '786p' }), '¥0.12/秒');
    assert.equal(formatModelSalePrice(pricing, { resolution: '2K' }), '¥0.20/秒');
    assert.equal(formatModelSalePrice(pricing, { resolution: '720p' }), '¥0.05-0.25/秒');
    const projected = getModelPresentation({ salePrices: [pricing] }, provider);
    assert.equal(projected.price, null);
    assert.deepEqual(projected.salePricing, pricing);
    const uniform = { ...pricing, prices: pricing.prices.map(price => ({ ...price, amount: 0.2 })) };
    assert.equal(getModelPresentation({ salePrices: [uniform] }, provider).price.amount, 0.2);
});

test('video reference tiers preserve token billing and ambiguous labels keep a range', () => {
    const pricing = { ...siteSale('cart.ravenhash.org'), note: '实际按生成 Token 计费', prices: [
        { label: '720p 无参考视频', amount: 20, unit: 'million_tokens' },
        { label: '720p 有参考视频', amount: 10, unit: 'million_tokens' },
        { label: '1080p 无参考视频', amount: 30, unit: 'million_tokens' },
        { label: '1080p 有参考视频', amount: 15, unit: 'million_tokens' }
    ] };
    assert.equal(formatModelSalePrice(pricing), '¥10.00-30.00/百万 Token');
    assert.equal(formatModelSalePrice(pricing, { resolution: '720p' }), '¥10.00-20.00/百万 Token');
    assert.equal(formatModelSalePrice(pricing, { resolution: '720p', hasVideoReference: false }), '¥20.00/百万 Token');
    assert.equal(formatModelSalePrice(pricing, { resolution: '1080p', hasVideoReference: true }), '¥15.00/百万 Token');
    assert.equal(formatModelSalePrice(pricing, { hasVideoReference: true }), '¥10.00-15.00/百万 Token');
    assert.equal(formatModelSalePriceDetails(pricing), '新站售价\n720p 无参考视频：¥20.00/百万 Token\n720p 有参考视频：¥10.00/百万 Token\n1080p 无参考视频：¥30.00/百万 Token\n1080p 有参考视频：¥15.00/百万 Token\n实际按生成 Token 计费');
    pricing.prices.push({ label: '特殊条件', amount: 40, unit: 'million_tokens' });
    assert.equal(formatModelSalePrice(pricing, { resolution: '720p', hasVideoReference: true }), '¥10.00-40.00/百万 Token');
    assert.equal(formatModelSalePrice({ ...siteSale(), prices: [
        { label: '1720p', amount: 1, unit: 'request' }, { label: '720p', amount: 2, unit: 'request' }
    ] }, { resolution: '720p' }), '¥2.00/次');
});

test('mixed billing units remain separate in the display and cannot become a legacy scalar', () => {
    const pricing = { ...siteSale(), prices: [
        { label: '基础', amount: 1, unit: 'request' }, { label: '生成', amount: 1, unit: 'million_tokens' }
    ] };
    assert.equal(formatModelSalePrice(pricing), '¥1.00/次；¥1.00/百万 Token');
    assert.equal(getModelPresentation({ salePrices: [pricing] }, provider).price, null);
});

test('both schemas accept scoped sale tiers and unknown snapshots but reject costs and duplicate hosts', () => {
    const serverSchema = JSON.parse(fs.readFileSync(new URL('../configserver/schema/model-config.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(serverSchema, schema);
    const config = structuredClone(DEFAULT_MODEL_CONFIG);
    const entry = entryFor(config);
    const art = siteSale();
    const cart = { ...siteSale('cart.ravenhash.org'), status: 'unknown', prices: [] };
    entry.salePrices = [art, cart];
    assert.equal(validate(config), true, JSON.stringify(validate.errors));
    const invalid = [
        [{ ...art, kind: 'cost' }], [{ ...art, host: 'art.ravenhash.org.evil.test' }],
        [{ ...art, prices: [] }], [art, { ...art, source: 'duplicate' }],
        [{ ...cart, updatedAt: 'yesterday' }], [{ ...art, prices: [{ label: '', amount: 0, unit: 'token' }] }],
        [{ ...art, prices: [{ label: '', amount: 0, unit: 'request', cost: 1 }] }]
    ];
    for (const salePrices of invalid) {
        entry.salePrices = salePrices;
        assert.equal(validate(config), false, JSON.stringify(salePrices));
    }
});

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
