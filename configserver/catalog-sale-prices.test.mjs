import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCatalogSalePrices } from './lib/catalog-sale-prices.mjs';
import { createConfigServer } from './server.mjs';
import { hashPassword } from './lib/auth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = 'art.ravenhash.org';
const CART = 'cart.ravenhash.org';
const CHECKED_AT = '2026-09-24T03:00:00.000Z';
const UNKNOWN_UPDATED_AT = '1970-01-01T00:00:00.000Z';
const SILENT = { log() {}, warn() {}, error() {} };

function modelEntry(model, hosts = [ART, CART]) {
    return { id: model, kind: 'video', match: { model: [`^${model}$`] }, catalog: { model, hosts } };
}

function snapshotFixture() {
    return {
        checkedAt: CHECKED_AT,
        sites: [ART, CART].map((host, index) => ({
            host, label: host, checkedAt: CHECKED_AT, currency: 'CNY', exchangeToCny: 1,
            models: [{ model: 'exact-model', status: 'known', active: true, currency: 'CNY',
                prices: [{ label: '720p', amount: index + 1, unit: 'second' }] }]
        }))
    };
}

test('sale prices bind exact catalog models and hosts without mutating the catalog', () => {
    const config = { revision: 12, models: [
        modelEntry('exact-model'), modelEntry('exact-model', [CART]),
        { ...modelEntry('alias'), id: 'exact-model' },
        modelEntry('EXACT-MODEL'), modelEntry('exact-model', ['upstream.example']),
        { id: 'exact-model', match: { model: ['^exact-model$'] } }
    ] };
    const before = structuredClone(config);
    const snapshot = snapshotFixture();
    snapshot.sites[0].models[0].ids = ['alias'];
    const output = withCatalogSalePrices(config, snapshot);
    assert.deepEqual(output.models[0].salePrices.map(price => [price.host, price.status, price.prices[0].amount]),
        [[ART, 'known', 1], [CART, 'known', 2]]);
    assert.deepEqual(output.models[1].salePrices.map(price => price.host), [CART]);
    assert.ok(output.models[2].salePrices.every(price => price.status === 'unknown'));
    assert.ok(output.models[3].salePrices.every(price => price.status === 'unknown'));
    assert.equal(output.models[4].salePrices, undefined);
    assert.equal(output.models[5].salePrices, undefined);
    assert.deepEqual(config, before);
});

test('missing prices replace stale sale data with deterministic unknown values', () => {
    const entry = { ...modelEntry('exact-model'), salePrices: [{ amount: 999, cost: 'private' }] };
    const prices = withCatalogSalePrices({ models: [entry] }, null).models[0].salePrices;
    assert.deepEqual(prices, [ART, CART].map(host => ({
        host, status: 'unknown', currency: 'CNY', kind: 'sale', source: 'relay billing snapshot',
        updatedAt: UNKNOWN_UPDATED_AT, prices: []
    })));
});

test('unsupported currencies, units and unknown models cannot become known sale prices', () => {
    for (const change of [
        model => { model.currency = 'EUR'; },
        model => { model.prices[0].unit = 'credit'; },
        model => { model.status = 'unknown'; model.reason = 'No configured billing rule'; },
        model => { model.prices = []; }
    ]) {
        const snapshot = snapshotFixture();
        change(snapshot.sites[0].models[0]);
        const price = withCatalogSalePrices({ models: [modelEntry('exact-model')] }, snapshot).models[0].salePrices[0];
        assert.equal(price.status, 'unknown');
        assert.deepEqual(price.prices, []);
        assert.equal(price.updatedAt, CHECKED_AT);
    }
    const snapshot = snapshotFixture();
    snapshot.sites[0].models[0].currency = 'USD';
    assert.equal(withCatalogSalePrices({ models: [modelEntry('exact-model')] }, snapshot).models[0].salePrices[0].currency, 'USD');
});

async function startServer() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-sale-prices-'));
    const seedPath = path.join(dataDir, 'seed.json');
    fs.writeFileSync(seedPath, JSON.stringify({ schemaVersion: 1, revision: 12, models: [modelEntry('exact-model')] }));
    const server = await createConfigServer({ dataDir, seedPath, port: 0, host: '127.0.0.1',
        passwordRecord: hashPassword('sale-prices-test'), logger: SILENT });
    return { server, dataDir, cleanup: async () => {
        await server.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    } };
}

test('/config refreshes prices and ETag without publishing or changing stored/admin documents', async () => {
    const { server, dataDir, cleanup } = await startServer();
    try {
        const file = path.join(dataDir, 'admin-model-prices.json');
        const snapshot = snapshotFixture();
        snapshot.credentials = 'root-secret';
        snapshot.cost = 'root-cost';
        snapshot.sites[0].token = 'site-secret';
        snapshot.sites[0].models[0].cost = 'model-cost';
        snapshot.sites[0].models[0].prices[0].raw = 'price-secret';
        fs.writeFileSync(file, JSON.stringify(snapshot));
        fs.writeFileSync(path.join(dataDir, 'admin-model-costs.json'), '{"secret":"cost-file-secret"}');
        const current = server.store.current();
        const names = server.store.listNames();
        const first = await fetch(`${server.url}/config`);
        const firstEtag = first.headers.get('etag');
        const firstText = await first.text();
        assert.equal(first.status, 200);
        assert.doesNotMatch(firstText, /secret|root-cost|model-cost|credentials|token|raw/);
        assert.deepEqual(JSON.parse(firstText).models[0].salePrices.map(price => price.prices[0].amount), [1, 2]);
        assert.equal((await fetch(`${server.url}/config`, { headers: { 'if-none-match': firstEtag } })).status, 304);

        snapshot.sites[1].models[0].prices[0].amount = 5.72;
        fs.writeFileSync(file, JSON.stringify(snapshot));
        const changed = await fetch(`${server.url}/config`, { headers: { 'if-none-match': firstEtag } });
        assert.equal(changed.status, 200);
        assert.notEqual(changed.headers.get('etag'), firstEtag);
        const changedText = await changed.text();
        const payload = JSON.parse(changedText);
        assert.equal(payload.revision, current.config.revision);
        assert.equal(payload.models[0].salePrices[1].prices[0].amount, 5.72);
        const preview = await fetch(`${server.url}/config/preview`);
        assert.equal(preview.headers.get('etag'), changed.headers.get('etag'));
        assert.equal(await preview.text(), changedText);
        assert.deepEqual(server.store.listNames(), names);
        assert.equal(server.store.current().text, current.text);
        assert.equal(server.store.read(current.name).text, current.text);
        assert.equal(server.store.current().config.models[0].salePrices, undefined);
    } finally { await cleanup(); }
});

test('/config fails closed for malformed snapshots, without falling back to seed prices', async () => {
    const { server, dataDir, cleanup } = await startServer();
    try {
        const invalidSnapshot = snapshotFixture();
        invalidSnapshot.sites[0].models[0].prices[0].amount = -1;
        for (const content of ['{broken', 'null', JSON.stringify(invalidSnapshot)]) {
            fs.writeFileSync(path.join(dataDir, 'admin-model-prices.json'), content);
            const response = await fetch(`${server.url}/config`);
            assert.equal(response.status, 200);
            const prices = (await response.json()).models[0].salePrices;
            assert.ok(prices.every(price => price.status === 'unknown' && price.prices.length === 0));
            assert.ok(prices.every(price => price.updatedAt === UNKNOWN_UPDATED_AT));
        }
    } finally { await cleanup(); }
});

test('/config stays available with unknown prices when snapshot files are missing', async t => {
    const originalRead = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function (file, ...args) {
        if (String(file) === path.join(HERE, 'seed', 'admin-model-prices.json')) throw new Error('Missing private path');
        return originalRead.call(this, file, ...args);
    });
    const { server, cleanup } = await startServer();
    try {
        const response = await fetch(`${server.url}/config`);
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.doesNotMatch(text, /private path/);
        assert.ok(JSON.parse(text).models[0].salePrices.every(price => price.status === 'unknown'));
    } finally { await cleanup(); }
});
