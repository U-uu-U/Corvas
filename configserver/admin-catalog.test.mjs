import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addCatalogModel, applyCatalogFields, catalogGroups, catalogGroupKey, catalogModelPrice, catalogModelSummary, createCatalogGroup,
    createCatalogHistory, deleteCatalogModel, moveCatalogModel, renameCatalogGroup, reorderCatalog,
    toggleCatalogVisibility } from './lib/admin-catalog-model.mjs';
import { applyEditorValues, readEditorValues } from './lib/admin-editor-model.mjs';
import { prepareRemoteCatalog } from '../scripts/prepare-remote-catalog.mjs';

const base = () => ({ schemaVersion: 1, revision: 12, other: { retained: true }, models: [
    { id: 'minimax', kind: 'video', catalog: { model: 'minimax-h3', hosts: ['art.example.com'] },
        presentation: { label: 'MiniMax H3', routeGroupOrder: 0 }, match: { model: ['^minimax-h3$'] } },
    { id: 'main', kind: 'video', catalog: { model: 'seedance.main', hosts: ['art.example.com'] },
        presentation: { label: 'Seedance Main', routeGroup: 'recommended', routeGroupLabel: '推荐渠道', routeGroupOrder: 10, routeOrder: 10 },
        match: { model: ['^seedance\\.main$'], provider: ['ravenhash'] },
        options: { duration: { type: 'fixed', value: 30 }, custom: { keep: [1, 2] } },
        pricing: { status: 'known', amount: 4, currency: 'CNY', source: 'keep' }, future: { keep: true } },
    { id: 'backup', kind: 'video', presentation: { label: 'Backup', routeGroup: 'recommended', routeGroupLabel: '推荐渠道', routeGroupOrder: 10, routeOrder: 20 },
        match: { model: ['^seedance[-.]backup.*$'] }, options: { duration: { type: 'range', min: 4, max: 30 } } }
] });

test('model card prices use only the old relay sale and preserve currency, billing unit and zero', () => {
    const pricing = { status: 'known', hosts: ['art.ravenhash.org'], amount: 6,
        currency: 'CNY', unit: 'request', kind: 'sale' };
    assert.equal(catalogModelPrice({ pricing }), '老站价格：¥6.00/次');
    assert.equal(catalogModelPrice({ pricing: { ...pricing, amount: 1.06, unit: 'second' } }), '老站价格：¥1.06/秒');
    assert.equal(catalogModelPrice({ pricing: { ...pricing, amount: 0, unit: 'image' } }), '老站价格：¥0.00/张');
    assert.equal(catalogModelPrice({ pricing: { ...pricing, amount: 0.0074, currency: 'USD' } }), '老站价格：US$0.0074/次');
    for (const hosts of [['cart.ravenhash.org'], ['api.xzapi.vip'], ['art.ravenhash.org.example'], []]) {
        assert.equal(catalogModelPrice({ pricing: { ...pricing, hosts } }), '老站价格：未配置');
    }
    assert.equal(catalogModelPrice({ pricing: { ...pricing, status: 'unknown' } }), '老站价格：待确认');
    for (const patch of [{ amount: '6' }, { amount: -1 }, { kind: 'cost' }, { unit: 'tokens' }]) {
        assert.equal(catalogModelPrice({ pricing: { ...pricing, ...patch } }), '老站价格：待确认');
    }
    assert.equal(catalogModelPrice({}), '老站价格：未配置');
});

test('group preview uses presentation without guessing a concrete ID from legacy patterns', () => {
    const config = base();
    const groups = catalogGroups(config);
    assert.equal(groups[0].label, 'MiniMax H3');
    assert.equal(groups[0].id, '');
    assert.equal(groups[1].label, '推荐渠道');
    assert.deepEqual(groups[1].entries.map(entry => entry.id), ['main', 'backup']);
    assert.equal(readEditorValues(config.models[2]).catalogModel, '');
    assert.equal(readEditorValues(config.models[2]).catalogHosts, '');
    assert.equal(catalogGroups(config, { query: 'art.example.com' }).length, 2);
});

test('admin preview retains disabled groups while explicit hiding remains separate', () => {
    const config = base();
    config.models[1].catalog.enabled = false;
    config.models[2].catalog = { model: 'backup', hosts: ['art.example.com'], enabled: false };
    const before = structuredClone(config);
    const options = { includeHidden: false, includeDisabled: true };
    let group = catalogGroups(config, options).find(group => group.id === 'recommended');
    assert.equal(group.disabled, true);
    assert.equal(group.disabledCount, 2);
    assert.deepEqual(group.entries.map(entry => entry.id), ['main', 'backup']);
    assert.deepEqual(config, before);
    assert.equal(catalogGroups(config, { includeHidden: false }).some(group => group.id === 'recommended'), false);
    config.models[2].catalog.enabled = true;
    group = catalogGroups(config, options).find(group => group.id === 'recommended');
    assert.equal(group.disabled, false);
    assert.equal(group.disabledCount, 1);
    assert.equal(group.totalCount, 2);
    config.models[2].presentation.visible = false;
    group = catalogGroups(config, options).find(group => group.id === 'recommended');
    assert.equal(group.disabled, false, 'An explicitly hidden enabled member does not disable the whole group');
    assert.deepEqual(group.entries.map(entry => entry.id), ['main']);
    config.models[0].catalog.enabled = false;
    assert.ok(catalogGroups(config, options).some(group => group.entries[0].id === 'minimax'));
});

test('copy, regroup, rename, move, hide, and delete preserve unrelated generation and billing fields', () => {
    const initial = base();
    const before = structuredClone(initial);
    const added = addCatalogModel(initial, { sourceId: 'main', model: 'seedance.other+1',
        hosts: 'CART.EXAMPLE.COM, cart.example.com', label: 'New Channel', groupKey: 'video:recommended' });
    let config = added.config;
    const copy = config.models.find(entry => entry.id === added.id);
    assert.deepEqual(copy.options, initial.models[1].options);
    assert.deepEqual(copy.pricing, initial.models[1].pricing);
    assert.deepEqual(copy.future, initial.models[1].future);
    assert.deepEqual(copy.catalog.hosts, ['cart.example.com']);
    assert.deepEqual(copy.match.model, ['^seedance\\.other\\+1$']);
    assert.deepEqual(copy.match.provider, initial.models[1].match.provider);
    config = createCatalogGroup(config, added.id, '备用渠道');
    assert.equal(config.models.find(entry => entry.id === added.id).presentation.routeLabel, 'New Channel');
    const key = catalogGroupKey(config.models.find(entry => entry.id === added.id));
    config = renameCatalogGroup(config, key, '备用分组2');
    config = moveCatalogModel(config, 'backup', key);
    assert.equal(config.models.find(entry => entry.id === 'backup').presentation.routeGroupLabel, '备用分组2');
    config = reorderCatalog(config, 'backup', -1, 'model');
    assert.deepEqual(catalogGroups(config).find(group => group.key === key).entries.map(entry => entry.id), ['backup', added.id]);
    config = reorderCatalog(config, added.id, -1, 'group');
    assert.equal(catalogGroups(config)[1].key, key);
    config = toggleCatalogVisibility(config, added.id);
    assert.equal(config.models.find(entry => entry.id === added.id).presentation.visible, false);
    assert.equal(config.models.find(entry => entry.id === added.id).catalog.enabled, true);
    assert.ok(!catalogGroups(config, { includeHidden: false }).flatMap(group => group.entries).some(entry => entry.id === added.id));
    config = deleteCatalogModel(config, added.id);
    assert.deepEqual(config.models.find(entry => entry.id === 'main').options, before.models[1].options);
    assert.deepEqual(config.other, before.other);
    assert.deepEqual(initial, before);
});

test('cleared catalogs can be recreated and history restores complete prior JSON', () => {
    const config = base();
    const history = createCatalogHistory(config);
    const empty = { ...config, models: [] };
    history.push(empty);
    const created = addCatalogModel(empty, { model: 'new.model', hosts: 'art.example.com', label: 'New Model' }).config;
    history.push(created);
    assert.equal(history.canUndo, true);
    assert.deepEqual(history.undo(), empty);
    assert.deepEqual(history.undo(), config);
    assert.equal(history.canUndo, false);
    assert.deepEqual(history.redo(), empty);
    history.push({ ...empty, revision: 13 });
    assert.equal(history.canRedo, false);
    assert.deepEqual(config.models.length, 3);
});

test('display toggles never enable or disable the catalog channel', () => {
    for (const enabled of [true, false, undefined]) {
        const config = base();
        config.models[0].catalog = { ...config.models[0].catalog, ...(enabled === undefined ? {} : { enabled }) };
        const catalog = structuredClone(config.models[0].catalog);
        const hidden = toggleCatalogVisibility(config, 'minimax');
        assert.equal(hidden.models[0].presentation.visible, false);
        assert.deepEqual(hidden.models[0].catalog, catalog);
        const shown = toggleCatalogVisibility(hidden, 'minimax');
        assert.equal(shown.models[0].presentation.visible, true);
        assert.deepEqual(shown.models[0].catalog, catalog);
        const available = catalogGroups(shown, { includeHidden: false }).flatMap(group => group.entries);
        assert.equal(available.some(entry => entry.id === 'minimax'), enabled !== false);
        assert.equal(catalogGroups(shown, { includeHidden: true }).flatMap(group => group.entries)
            .some(entry => entry.id === 'minimax'), true);
    }
});

test('explicit model and hosts are validated and edits preserve untouched metadata', () => {
    const entry = base().models[1];
    for (const values of [{ catalogModel: 'new', catalogHosts: 'https://api.example.com/v1' },
        { catalogModel: 'new', catalogHosts: '*.example.com' },
        { catalogModel: '', catalogHosts: 'api.example.com' },
        { catalogModel: 'new key', catalogHosts: 'api.example.com' }]) {
        assert.throws(() => applyCatalogFields(entry, values));
    }
    const next = applyEditorValues(entry, { ...readEditorValues(entry), catalogModel: 'new.model' }, new Set(['catalogModel']));
    assert.deepEqual(next.match.model, ['^new\\.model$']);
    assert.deepEqual(next.options, entry.options);
    assert.deepEqual(next.pricing, entry.pricing);
    assert.throws(() => addCatalogModel(base(), { model: 'seedance.main', hosts: 'art.example.com', label: 'Duplicate' }));
    assert.equal(applyCatalogFields(entry, { catalogModel: '', catalogHosts: '' }).catalog, undefined);
});

test('group movement is type-scoped and moving out keeps the entry independent', () => {
    const config = base();
    config.models.push({ id: 'image', kind: 'image', presentation: { routeGroup: 'image-group', routeGroupLabel: 'Image' } });
    assert.throws(() => moveCatalogModel(config, 'main', 'image:image-group'));
    const next = moveCatalogModel(config, 'main', '');
    assert.equal(next.models[1].presentation.routeGroup, '');
    assert.equal(catalogGroups(next).find(group => group.entries.some(entry => entry.id === 'main')).id, '');
    assert.equal(config.models[1].presentation.routeGroup, 'recommended');
});

test('preview defaults and tie breakers match the canvas, including the migrated catalog', () => {
    const config = { models: [
        { id: 'group-b', kind: 'video', presentation: { routeGroup: 'g', routeGroupOrder: 10, routeLabel: 'B' } },
        { id: 'group-a', kind: 'video', presentation: { routeGroup: 'g', routeGroupOrder: 10, routeLabel: 'A' } },
        { id: 'group-a2', kind: 'video', presentation: { routeGroup: 'g', routeGroupOrder: 10, routeLabel: 'A' } },
        { id: 'standalone', kind: 'video' }
    ] };
    const groups = catalogGroups(config);
    assert.equal(groups[0].entries[0].id, 'standalone');
    assert.deepEqual(groups[1].entries.map(entry => entry.id), ['group-a', 'group-a2', 'group-b']);
    const prepared = prepareRemoteCatalog(JSON.parse(fs.readFileSync(new URL('../shared/model-config.default.json', import.meta.url), 'utf8')));
    assert.deepEqual(catalogGroups(prepared, { kind: 'video', includeHidden: false, includeLegacy: false }).map(group => group.label),
        ['MiniMax H3', 'Seedance 2.5 推荐渠道', 'Seedance 2.5 备用渠道', 'Seedance 2.0 推荐渠道']);
});

test('capability summaries use only declared parameters and never include pricing or provider notes', () => {
    const entry = { options: { resolutionTier: { type: 'enum', values: ['720p', '1080p'] },
        duration: { type: 'range', min: 4, max: 30 } }, capabilities: {
        referenceImages: { supported: true, max: 9, note: 'Internal price 99' },
        referenceVideos: { supported: true, max: 10 }, referenceAudios: { supported: false } },
    pricing: { amount: 99, currency: 'CNY' } };
    assert.equal(catalogModelSummary(entry), '720p/1080p；4-30 秒；最多 9 图 / 10 视频参考；不支持音频参考');
    assert.equal(catalogModelSummary({ options: { resolutionTier: { type: 'fixed', value: '720p' },
        duration: { type: 'fixed', value: 30 } } }), '720p；固定 30 秒');
    assert.equal(catalogModelSummary({ options: { duration: { type: 'enum', values: [5, 10] } },
        capabilities: { referenceImages: { supported: true } } }), '5/10 秒；支持图参考');
    assert.equal(catalogModelSummary({}), '');
});
