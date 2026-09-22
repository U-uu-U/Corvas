import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createConfigStore } from './lib/store.mjs';
import { createValidator } from './lib/validate.mjs';
import { executeCatalogControl } from './catalog-control.mjs';

const schemaPath = fileURLToPath(new URL('./schema/model-config.schema.json', import.meta.url));
const cliPath = fileURLToPath(new URL('./catalog-control.mjs', import.meta.url));

function model(id, overrides = {}) {
    return {
        id, kind: 'video', match: { model: [`^${id}$`] },
        catalog: { model: id, hosts: ['art.ravenhash.org', 'cart.ravenhash.org'] },
        presentation: { label: `Model ${id}`, routeGroup: 'recommended', visible: true },
        pricing: {
            status: 'known', hosts: ['cart.ravenhash.org'], amount: 1.25,
            currency: 'CNY', unit: 'second', kind: 'sale', source: 'fixture',
            updatedAt: '2026-09-22T00:00:00.000Z'
        },
        ...overrides
    };
}

function fixture(t, models = [model('first'), model('second'), model('image', { kind: 'image' })]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-control-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const store = createConfigStore({ dataDir });
    const config = { schemaVersion: 1, catalogMode: 'remote', models };
    store.save(config, { channel: 'stable' });
    const preview = store.save(config, { channel: 'preview' });
    const execute = (request, options = {}) => executeCatalogControl(request, { dataDir, schemaPath, store, ...options });
    const set = (target = { id: 'first' }, enabled = false, options = {}) => execute({
        action: 'set', target, enabled, expectedRevision: store.current('preview').config.revision, ...options
    });
    return { dataDir, store, execute, set, preview };
}

test('lists concise entries without prices or full config', async t => {
    const { execute, preview } = fixture(t);
    const result = await execute({ action: 'list', query: 'FIRST' });
    assert.equal(result.channel, 'preview');
    assert.equal(result.revision, preview.revision);
    assert.equal(result.version, preview.name);
    assert.deepEqual(result.models, [{ id: 'first', model: 'first', label: 'Model first', group: 'recommended', enabled: true, visible: true }]);
    assert.equal(JSON.stringify(result).includes('pricing'), false);
    assert.equal(JSON.stringify(result).includes('hosts'), false);
});

test('disables exact entry, records only enabled fields, restores missing enabled', async t => {
    const { dataDir, store, set, execute, preview } = fixture(t);
    const stable = store.current('stable').name;
    const result = await set();
    assert.equal(result.changed, 1);
    assert.equal(store.current('stable').name, stable);
    const changed = store.current('preview').config.models[0];
    assert.equal(changed.catalog.enabled, false);
    assert.deepEqual(changed.presentation, preview.config.models[0].presentation);
    assert.deepEqual(changed.pricing, preview.config.models[0].pricing);
    const receipt = JSON.parse(fs.readFileSync(path.join(dataDir, 'operations', `${result.receiptId}.json`), 'utf8'));
    assert.equal(receipt.status, 'applied');
    assert.equal(receipt.beforeVersion, preview.name);
    assert.equal(receipt.afterVersion, result.version);
    assert.deepEqual(receipt.changes, [{ id: 'first', before: { present: false }, after: { present: true, value: false } }]);
    assert.equal(JSON.stringify(receipt).includes('hosts'), false);
    assert.equal(JSON.stringify(receipt).includes('pricing'), false);
    const restored = await execute({ action: 'restore', receiptId: result.receiptId });
    assert.equal(restored.changed, 1);
    assert.equal(Object.hasOwn(store.current('preview').config.models[0].catalog, 'enabled'), false);
    const again = await execute({ action: 'restore', receiptId: result.receiptId });
    assert.equal(again.changed, 0);
    assert.equal(again.version, restored.version);
});

test('group set defaults to video and leaves image entries alone', async t => {
    const { set, store } = fixture(t);
    const result = await set({ group: 'recommended' });
    assert.equal(result.changed, 2);
    assert.deepEqual(store.current('preview').config.models.map(entry => entry.catalog.enabled), [false, false, undefined]);
});

test('group set toggles managed entries and leaves legacy entries unchanged', async t => {
    const legacy = model('legacy');
    delete legacy.catalog;
    const { set, store } = fixture(t, [model('first'), model('second'), legacy]);
    const disabled = await set({ group: 'recommended' }, false);
    assert.equal(disabled.changed, 2);
    assert.deepEqual(store.current('preview').config.models.slice(0, 2).map(entry => entry.catalog.enabled), [false, false]);
    assert.deepEqual(store.current('preview').config.models[2], legacy);
    const enabled = await set({ group: 'recommended' }, true);
    assert.equal(enabled.changed, 2);
    assert.deepEqual(store.current('preview').config.models.slice(0, 2).map(entry => entry.catalog.enabled), [true, true]);
    assert.deepEqual(store.current('preview').config.models[2], legacy);
});

test('group with only legacy entries is not a managed target', async t => {
    const legacy = model('legacy');
    delete legacy.catalog;
    const { set, store, preview } = fixture(t, [legacy]);
    await assert.rejects(set({ group: 'recommended' }, false), { code: 'NOT_FOUND' });
    await assert.rejects(set({ group: 'recommended' }, true), { code: 'NOT_FOUND' });
    assert.equal(store.current('preview').name, preview.name);
    assert.deepEqual(store.current('preview').config.models, [legacy]);
});

test('exact catalog model lookup rejects duplicate upstream model names', async t => {
    const duplicate = model('second', { catalog: { model: 'first', hosts: ['cart.ravenhash.org'] } });
    const { set } = fixture(t, [model('first'), duplicate]);
    await assert.rejects(set({ model: 'first' }), { code: 'AMBIGUOUS_TARGET' });
    const result = await set({ id: 'second' });
    assert.equal(result.changed, 1);
});

test('set by model, no-op and explicit false restore work', async t => {
    const first = model('first');
    first.catalog.enabled = false;
    const { set, store, execute, preview } = fixture(t, [first]);
    const noOp = await set({ model: 'first' }, false);
    assert.equal(noOp.changed, 0);
    assert.equal(noOp.version, preview.name);
    const enabled = await set({ model: 'first' }, true);
    assert.equal(store.current('preview').config.models[0].catalog.enabled, true);
    await execute({ action: 'restore', receiptId: enabled.receiptId });
    assert.equal(store.current('preview').config.models[0].catalog.enabled, false);
});

test('default enabled true does not create a redundant version', async t => {
    const { set, preview, dataDir } = fixture(t);
    const result = await set({ id: 'first' }, true);
    assert.equal(result.changed, 0);
    assert.equal(result.version, preview.name);
    assert.equal(fs.existsSync(path.join(dataDir, 'operations')), false);
});

test('missing catalog cannot be enabled, disabling it is a no-op', async t => {
    const first = model('first');
    delete first.catalog;
    const { set, preview } = fixture(t, [first]);
    await assert.rejects(set({ id: 'first' }, true), { code: 'MISSING_CATALOG' });
    const result = await set();
    assert.equal(result.changed, 0);
    assert.equal(result.version, preview.name);
});

test('revision is required and conflicting revisions publish nothing', async t => {
    const { execute, set, store, preview } = fixture(t);
    await assert.rejects(execute({ action: 'set', target: { id: 'first' }, enabled: false }), { code: 'INVALID_REQUEST' });
    await assert.rejects(set({ id: 'first' }, false, { expectedRevision: 0 }), { code: 'CONFLICT' });
    assert.equal(store.current('preview').name, preview.name);
});

test('restoring retains later changes to prices, presentation and unrelated entries', async t => {
    const { set, execute, store } = fixture(t);
    const result = await set();
    const newer = structuredClone(store.current('preview').config);
    newer.models[0].pricing.amount = 9.99;
    newer.models[0].presentation.visible = false;
    newer.models[0].presentation.label = 'Renamed after operation';
    newer.models[1].catalog.enabled = false;
    newer.models.push(model('new-model'));
    store.save(newer, { channel: 'preview' });
    await execute({ action: 'restore', receiptId: result.receiptId });
    const expected = structuredClone(newer.models);
    delete expected[0].catalog.enabled;
    assert.deepEqual(store.current('preview').config.models, expected);
});

test('restore refuses targets changed or removed after the operation', async t => {
    const { set, execute, store } = fixture(t);
    const result = await set();
    const newer = structuredClone(store.current('preview').config);
    newer.models[0].catalog.enabled = true;
    const saved = store.save(newer, { channel: 'preview' });
    await assert.rejects(execute({ action: 'restore', receiptId: result.receiptId }), { code: 'CONFLICT' });
    assert.equal(store.current('preview').name, saved.name);
    newer.models.shift();
    store.save(newer, { channel: 'preview' });
    await assert.rejects(execute({ action: 'restore', receiptId: result.receiptId }), { code: 'CONFLICT' });
});

test('invalid receipt identifiers cannot escape operations directory', async t => {
    const { execute } = fixture(t);
    for (const receiptId of ['../../state', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
        await assert.rejects(execute({ action: 'restore', receiptId }), { code: 'INVALID_RECEIPT' });
    }
});

test('validates the entire config before saving', async t => {
    const bad = model('first');
    bad.presentation.visible = 'bad';
    const { set, store, preview } = fixture(t, [bad]);
    const validator = await createValidator({ schemaPath });
    assert.equal(validator.mode, 'schema');
    await assert.rejects(set(), { code: 'VALIDATION_FAILED' });
    assert.equal(store.current('preview').name, preview.name);
});

test('checks active version again immediately before set save', async t => {
    const { execute, store, preview } = fixture(t);
    let reads = 0;
    let published;
    const racingStore = { ...store, current(channel) {
        reads += 1;
        if (reads === 2) published = store.save(store.current(channel).config, { channel });
        return store.current(channel);
    } };
    await assert.rejects(execute({
        action: 'set', target: { id: 'first' }, enabled: false, expectedRevision: preview.revision
    }, { store: racingStore }), { code: 'CONFLICT' });
    assert.equal(store.current('preview').name, published.name);
    assert.equal(store.current('preview').config.models[0].catalog.enabled, undefined);
});

test('checks active version again immediately before restore save', async t => {
    const { execute, set, store } = fixture(t);
    const operation = await set();
    let reads = 0;
    let published;
    const racingStore = { ...store, current(channel) {
        reads += 1;
        if (reads === 2) published = store.save(store.current(channel).config, { channel });
        return store.current(channel);
    } };
    await assert.rejects(execute({ action: 'restore', receiptId: operation.receiptId }, { store: racingStore }), { code: 'CONFLICT' });
    assert.equal(store.current('preview').name, published.name);
    assert.equal(store.current('preview').config.models[0].catalog.enabled, false);
});

test('writes prepared receipt before set save', async t => {
    const { execute, store, dataDir, preview } = fixture(t);
    const checkedStore = { ...store, save(config, options) {
        const files = fs.readdirSync(path.join(dataDir, 'operations'));
        assert.equal(files.length, 1);
        const prepared = JSON.parse(fs.readFileSync(path.join(dataDir, 'operations', files[0]), 'utf8'));
        assert.equal(prepared.status, 'prepared');
        assert.equal(prepared.afterVersion, null);
        return store.save(config, options);
    } };
    await execute({ action: 'set', target: { id: 'first' }, enabled: false, expectedRevision: preview.revision }, { store: checkedStore });
});

test('CLI returns structured errors without echoing invalid input', t => {
    const { dataDir } = fixture(t);
    const result = spawnSync(process.execPath, [cliPath, '--data-dir', dataDir, '--schema-path', schemaPath], {
        input: '{private-invalid-input', encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, false);
    assert.equal(parsed.code, 'INVALID_REQUEST');
    assert.equal(result.stdout.includes('private-invalid-input'), false);
    assert.equal(result.stderr, '');
});
