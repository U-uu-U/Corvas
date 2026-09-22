import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareRemoteCatalog } from '../scripts/prepare-remote-catalog.mjs';
import { expandCatalogProviders, findCatalogEntry } from './model-catalog.mjs';

const source = JSON.parse(fs.readFileSync(new URL('./model-config.default.json', import.meta.url), 'utf8'));
const byId = (config, id) => config.models.find(entry => entry.id === id);
const provider = (model, host = 'art.ravenhash.org') => ({ id: 'test-account', capability: 'video',
    endpoint: `https://${host}/v1`, model });

test('preparation preserves source data, capabilities and all price metadata', () => {
    const input = structuredClone(source);
    input.revision = 12;
    input.updatedAt = '2026-09-23T00:00:00.000Z';
    const before = structuredClone(input);
    const config = prepareRemoteCatalog(input);
    assert.deepEqual(input, before);
    assert.equal(config.catalogMode, 'remote');
    assert.equal(config.source, 'prepared:remote-catalog-v1');
    assert.equal(config.schemaVersion, input.schemaVersion);
    assert.equal(config.revision, 12);
    assert.equal(config.updatedAt, input.updatedAt);
    for (const original of input.models) {
        const prepared = byId(config, original.id);
        for (const field of ['capabilities', 'parameters', 'options', 'pricing', 'priority', 'prompt', 'limits', 'notes']) {
            assert.deepEqual(prepared[field], original[field], `${original.id}: ${field}`);
        }
    }
    assert.deepEqual(prepareRemoteCatalog(config), config);
});

test('existing catalog entries and presentation are never overwritten', () => {
    const input = structuredClone(source);
    const shanhai = byId(input, 'shanhai-video.oc-model-qbdmeb');
    shanhai.catalog = { model: 'user-chosen', hosts: ['custom.test'], enabled: true };
    shanhai.match = { model: ['^user-regex.*$'] };
    shanhai.presentation = { label: 'User label', visible: true, routeOrder: 17 };
    const minimax = byId(input, 'minimax-video.minimax-h3-seconds');
    minimax.catalog = { model: 'user-minimax', hosts: ['minimax.test'], enabled: false };
    minimax.presentation = { label: 'Custom MiniMax', routeGroup: 'custom' };
    const config = prepareRemoteCatalog(input);
    assert.deepEqual(byId(config, shanhai.id), shanhai);
    assert.deepEqual(byId(config, minimax.id), minimax);
});

test('deployed mappings use exact wire models and hostname boundaries', () => {
    const config = prepareRemoteCatalog(source);
    for (const model of ['sd2.5-route1', 'sd2.5', 'seedance-2.5-pro', 'seedance_v2.5', 'seedance_v2.0-933',
        'ch0107-sd-2.5-720p', 'ch1401-sd-2.5-720p']) {
        for (const host of ['art.ravenhash.org', 'cart.ravenhash.org']) {
            const entry = findCatalogEntry(config, provider(model, host));
            assert.ok(entry, `${host}: ${model}`);
            assert.equal(entry.catalog.enabled, true);
            const pattern = new RegExp(entry.match.model[0]);
            assert.equal(pattern.test(model), true);
            assert.equal(pattern.test(`${model}-suffix`), false);
            assert.equal(pattern.test(`prefix-${model}`), false);
        }
        assert.equal(findCatalogEntry(config, provider(model, 'other.test')), null);
    }
    assert.equal(findCatalogEntry(config, provider('sd2x5-route1')), null);
    assert.equal(findCatalogEntry(config, provider('sd2.5-route2')), null);
    assert.equal(findCatalogEntry(config, provider('ch0107-sd-2.5-720p', 'api.xzapi.vip')).id, 'starframe.ch0107-sd-2.5-720p');
    for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'mj_imagine']) {
        assert.ok(findCatalogEntry(config, { ...provider(model, 'ai.ravenhash.org'), capability: 'image' }));
        assert.equal(findCatalogEntry(config, { ...provider(model), capability: 'image' }), null);
    }
});

test('withdrawn channels stay disabled and Shanhai also stays hidden', () => {
    const config = prepareRemoteCatalog(source);
    for (const model of ['seedance_v2.5-101010', 'seedance_v2.5-301010']) {
        assert.equal(findCatalogEntry(config, provider(model)).catalog.enabled, false);
    }
    for (const suffix of ['qbdmeb', '1iq31f', 'bkb50q', 'c6ws7e']) {
        for (const host of ['art.ravenhash.org', 'cart.ravenhash.org', 'shanhai.vnshu.cn']) {
            const entry = findCatalogEntry(config, provider(`oc-model-${suffix}`, host));
            assert.equal(entry.catalog.enabled, false);
            assert.equal(entry.presentation.visible, false);
        }
    }
    assert.equal(findCatalogEntry(config, provider('sd_2.5_discount_v1', 'zcbservice.aizfw.cn')).catalog.enabled, false);
    assert.equal(findCatalogEntry(config, provider('sd_2.5_discount_v1')), null);
    const selected = expandCatalogProviders(config, [provider('unused')]);
    assert.equal(selected.some(item => item.model.startsWith('oc-model-')), false);
    assert.equal(selected.some(item => /101010|301010/.test(item.model)), false);
});

test('only the seconds MiniMax route owns the relay catalog binding', () => {
    const config = prepareRemoteCatalog(source);
    const entry = findCatalogEntry(config, provider('minimax-h3'));
    assert.equal(entry.id, 'minimax-video.minimax-h3-seconds');
    assert.equal(entry.presentation.label, 'MiniMax H3');
    assert.equal(entry.presentation.routeGroup, '');
    for (const id of ['ravenhash-video.minimax-h3', 'minimax-video.minimax-h3-c1']) {
        assert.deepEqual(byId(config, id), byId(source, id));
        assert.equal(byId(config, id).catalog, undefined);
    }
    for (const entry of config.models.filter(entry => entry.kind === 'text')) {
        assert.deepEqual(entry, byId(source, entry.id));
        assert.equal(entry.catalog, undefined);
    }
});

test('Seedance 2.0 splits into three explicit variants with independent copied capabilities', () => {
    const input = structuredClone(source);
    const generic = byId(input, 'ravenhash-video.seedance-2.0');
    generic.pricing = { status: 'unknown', hosts: ['art.ravenhash.org'] };
    const config = prepareRemoteCatalog(input);
    assert.deepEqual(byId(config, generic.id), generic);
    assert.equal(byId(config, generic.id).catalog, undefined);
    for (const [order, variant] of ['fast', 'mini', 'pro'].entries()) {
        const entry = byId(config, `ravenhash-video.seedance-2.0-${variant}`);
        assert.equal(entry.catalog.model, `artsdance2-0-${variant}-intl-260701`);
        assert.equal(entry.catalog.enabled, true);
        assert.deepEqual(entry.capabilities, generic.capabilities);
        assert.deepEqual(entry.parameters, generic.parameters);
        assert.deepEqual(entry.options, generic.options);
        assert.deepEqual(entry.pricing, generic.pricing);
        assert.equal(entry.presentation.routeOrder, order);
        assert.equal(entry.presentation.routeGroupOrder, 100);
        assert.equal(entry.presentation.routeGroup, 'seedance20-recommended');
        assert.equal(entry.presentation.label, `Seedance 2.0 ${variant[0].toUpperCase()}${variant.slice(1)}`);
        assert.equal(entry.presentation.routeLabel, entry.presentation.label);
        assert.notEqual(entry.capabilities, generic.capabilities);
        assert.equal(findCatalogEntry(config, provider(entry.catalog.model)), entry);
    }
    assert.equal(findCatalogEntry(config, provider('doubao-seedance-2-0')), null);
});

test('CLI writes only the chosen publication file and reports a compact summary', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-catalog-test-'));
    try {
        const sourcePath = path.join(directory, 'source.json');
        const outputPath = path.join(directory, 'publication.json');
        const input = JSON.stringify(source);
        fs.writeFileSync(sourcePath, input);
        const script = fileURLToPath(new URL('../scripts/prepare-remote-catalog.mjs', import.meta.url));
        const run = spawnSync(process.execPath, [script, '--source', sourcePath, '--output', outputPath], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).catalogMode, 'remote');
        assert.equal(fs.readFileSync(sourcePath, 'utf8'), input);
        assert.ok(run.stdout.includes(outputPath));
        assert.equal(run.stdout.includes('"models"'), false);
        const overwrite = spawnSync(process.execPath, [script, '--source', sourcePath, '--output', sourcePath], { encoding: 'utf8' });
        assert.equal(overwrite.status, 1);
        assert.equal(fs.readFileSync(sourcePath, 'utf8'), input);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
