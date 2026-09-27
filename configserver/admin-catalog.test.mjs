import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addCatalogModel, applyCatalogFields, catalogGroups, catalogGroupKey, catalogModelPrices, catalogModelSource, catalogModelSummary, createCatalogGroup,
    createCatalogHistory, deleteCatalogGroup, deleteCatalogModel, groupCatalogModel, moveCatalogModel, normalizeCatalogWorkspace, placeCatalogGroup, renameCatalogGroup, reorderCatalog, reorderCatalogGroup, setCatalogDefaultModel, setCatalogEnabled,
    toggleCatalogVisibility } from './lib/admin-catalog-model.mjs';
import { applyEditorValues, readEditorValues } from './lib/admin-editor-model.mjs';
import { prepareRemoteCatalog } from '../scripts/prepare-remote-catalog.mjs';
import { getCatalogProviderEntries } from '../shared/model-catalog.mjs';

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

test('remote default selection is explicit and cleared when its model leaves the usable catalog', () => {
    const initial = base();
    const selected = setCatalogDefaultModel(initial, 'video', 'main');
    assert.equal(selected.defaultModels.video, 'main');
    assert.deepEqual(selected.models, initial.models);
    assert.equal(setCatalogDefaultModel(selected, 'video', '').defaultModels, undefined);
    assert.equal(moveCatalogModel(selected, 'main', '').defaultModels, undefined);
    assert.equal(normalizeCatalogWorkspace(setCatalogEnabled(selected, 'main', false)).defaultModels, undefined);
    assert.throws(() => setCatalogDefaultModel(initial, 'video', 'backup'), /默认模型/);
    assert.throws(() => setCatalogDefaultModel(initial, 'image', 'main'), /默认模型/);
});

test('model cards show independently verified site prices and billing units instead of CONFIG metadata', () => {
    const entry = { id: 'legacy', catalog: { model: 'test-model' }, pricing: { amount: 999 } };
    const record = { model: 'test-model', ids: ['legacy'], status: 'known', active: true, currency: 'CNY',
        prices: [{ label: '', amount: 6, unit: 'request' }] };
    const snapshot = { checkedAt: '2026-09-23T00:00:00Z', sites: [
        { host: 'art.ravenhash.org', models: [record] },
        { host: 'cart.ravenhash.org', models: [{ ...record, prices: [{ label: '720p', amount: 1.25, unit: 'second' }] }] }
    ] };
    const texts = entry => catalogModelPrices(entry, snapshot).map(line => line.text);
    assert.deepEqual(texts(entry), ['老站价格：¥6.00/次', '新站价格：720p ¥1.25/秒']);
    assert.deepEqual(texts({ id: 'legacy' }), texts(entry));
    assert.deepEqual(texts({ ...entry, catalog: { model: 'other' } }), ['老站价格：未接入', '新站价格：未接入']);
    assert.deepEqual(texts({ id: 'unknown' }), ['老站价格：待绑定模型', '新站价格：待绑定模型']);
    assert.deepEqual(texts({ kind: 'image', catalog: { model: 'unverified-image' } }), ['老站价格：待核对', '新站价格：待核对']);
    record.active = false;
    record.prices[0].amount = 0;
    assert.equal(texts(entry)[0], '老站价格：¥0.00/次（已下架）');
    record.prices = [{ label: '720p 无参考视频', amount: 46.368, unit: 'million_tokens' }];
    assert.equal(texts(entry)[0], '老站价格：720p 无参考视频 ¥46.37/百万 Token（已下架）');
    record.status = 'missing_rule';
    assert.equal(texts(entry)[0], '老站价格：未配置计费规则');
    record.status = 'inactive_rule';
    assert.equal(texts(entry)[0], '老站价格：计费规则已停用');
    assert.equal(catalogModelPrices(entry, null)[0].text, '老站价格：读取中');
    assert.equal(catalogModelPrices(entry, { error: true })[0].text, '老站价格：读取失败');
    assert.equal(catalogModelPrices(entry, {})[0].text, '老站价格：待核对');
    assert.match(catalogModelPrices(entry, snapshot)[0].title, /2026-09-23/);
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

test('upstream labels follow verified relay bindings and reject stale bindings or credential URLs', () => {
    const sources = JSON.parse(fs.readFileSync(new URL('./seed/admin-model-sources.json', import.meta.url), 'utf8'));
    const entry = { id: 'ravenhash-video.seedance-2.5-pro-1',
        catalog: { model: 'seedance-2.5-pro', hosts: ['art.ravenhash.org'] } };
    assert.equal(catalogModelSource(entry, sources).name, '上游：Yueqi');
    assert.equal(catalogModelSource({ ...entry, id: 'ravenhash-video.seedance-2.5-pro' }, sources).name, '上游：Yueqi');
    assert.deepEqual(catalogModelSource({ id: 'ravenhash-video.sd2.5', catalog: { model: 'sd2.5', hosts: ['art.ravenhash.org'] } }, sources),
        { name: '上游：主播视频', url: 'URL：https://video.zhubo.asia' });
    assert.equal(catalogModelSource({ id: 'minimax-video.minimax-h3-seconds',
        catalog: { model: 'minimax-h3', hosts: ['art.ravenhash.org'] } }, sources).url, 'URL：http://122.228.216.60:3000');
    for (const patch of [{ id: 'new-id' }, { catalog: { model: 'other', hosts: ['art.ravenhash.org'] } },
        { catalog: { model: 'seedance-2.5-pro', hosts: ['other.example'] } }]) {
        assert.deepEqual(catalogModelSource({ ...entry, ...patch }, sources), { name: '上游：待确认', url: 'URL：待确认' });
    }
    assert.equal(catalogModelSource(entry, null).name, '上游：读取中');
    assert.equal(catalogModelSource(entry, { error: true }).name, '上游：读取失败');
    const record = sources.entries.find(source => source.ids.includes(entry.id));
    for (const url of ['javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#secret']) {
        assert.equal(catalogModelSource(entry, { entries: [{ ...record, url }] }).url, 'URL：待确认');
    }
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

test('card call switches preserve visibility and all unrelated model fields', () => {
    const initial = base();
    const disabled = setCatalogEnabled(initial, 'main', false);
    assert.equal(disabled.models[1].catalog.enabled, false);
    assert.deepEqual(disabled.models[1].presentation, initial.models[1].presentation);
    assert.deepEqual(disabled.models[1].options, initial.models[1].options);
    assert.deepEqual(disabled.models[1].pricing, initial.models[1].pricing);
    assert.equal(initial.models[1].catalog.enabled, undefined);
    assert.ok(catalogGroups(disabled, { includeHidden: false, includeDisabled: true }).flatMap(g => g.entries).some(m => m.id === 'main'));
    const enabled = setCatalogEnabled(disabled, 'main', true);
    assert.equal(enabled.models[1].catalog.enabled, true);
    assert.throws(() => setCatalogEnabled(initial, 'backup', true), /补全/);
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

test('empty groups survive serialization, assignment, last-member removal, rename and reordering', () => {
    const initial = base();
    let next = createCatalogGroup(initial, '', '空分组', 'video');
    const key = catalogGroups(next, { includeEmpty: true }).find(group => group.label === '空分组').key;
    assert.deepEqual(next.models, initial.models);
    next = JSON.parse(JSON.stringify(next));
    assert.equal(catalogGroups(next, { includeEmpty: true }).find(group => group.key === key).entries.length, 0);
    next = moveCatalogModel(next, 'minimax', key);
    assert.equal(catalogGroupKey(next.models[0]), key);
    next = moveCatalogModel(next, 'minimax', '');
    next = renameCatalogGroup(next, key, '新空分组');
    assert.throws(() => renameCatalogGroup(next, key, '推荐渠道'), /已有/);
    next = reorderCatalogGroup(next, key, -1);
    assert.equal(catalogGroups(next, { includeEmpty: true }).filter(group => group.id)[0].key, key);
    assert.equal(catalogGroups(next, { includeEmpty: true }).find(group => group.key === key).label, '新空分组');
    assert.equal(catalogGroups(next).some(group => group.key === key), false, 'Empty groups are omitted from legacy projections');
});

test('a model can become a same-named group without changing its generation or call settings', () => {
    const initial = base();
    initial.models[0].catalog.enabled = false;
    const before = structuredClone(initial);
    let next = groupCatalogModel(initial, 'minimax');
    const group = catalogGroups(next).find(group => group.id && group.entries.some(entry => entry.id === 'minimax'));
    assert.equal(group.label, 'MiniMax H3');
    assert.equal(group.entries.length, 1);
    assert.equal(group.entries[0].presentation.routeGroupAlways, true);
    assert.equal(group.entries[0].catalog.enabled, false);
    assert.deepEqual(groupCatalogModel(next, 'minimax'), next, 'Repeating promotion must not create another group');
    next = createCatalogGroup(initial, '', 'MiniMax H3');
    next = groupCatalogModel(next, 'minimax');
    assert.equal(next.models[0].presentation.routeGroupLabel, 'MiniMax H3 (2)');
    next = groupCatalogModel(initial, 'main');
    assert.equal(next.models[1].presentation.routeGroupLabel, 'Seedance Main');
    assert.equal(next.models[2].presentation.routeGroup, 'recommended');
    assert.deepEqual(next.models[1].options, initial.models[1].options);
    assert.deepEqual(next.models[1].pricing, initial.models[1].pricing);
    assert.deepEqual(initial, before);
});

test('group deletion unassigns all members including hidden or disabled models without changing call contracts', () => {
    const initial = base();
    initial.models[1].catalog.enabled = false;
    initial.models[2].presentation.visible = false;
    const history = createCatalogHistory(initial);
    const next = deleteCatalogGroup(initial, 'video:recommended');
    history.push(next);
    assert.equal(next.models.length, initial.models.length);
    assert.ok(next.models.every(entry => !entry.presentation.routeGroup));
    assert.equal(catalogGroups(next, { includeEmpty: true }).some(group => group.key === 'video:recommended'), false);
    for (let i = 0; i < initial.models.length; i++) {
        const { presentation: _before, ...before } = initial.models[i];
        const { presentation: _after, ...after } = next.models[i];
        assert.deepEqual(after, before);
        assert.equal(next.models[i].presentation.visible, initial.models[i].catalog ? false : initial.models[i].presentation.visible);
    }
    assert.deepEqual(history.undo(), initial);
    assert.deepEqual(history.redo(), next);
});

test('drag ordering targets the full group while preserving unfiltered members', () => {
    const initial = base();
    initial.models[2].presentation.visible = false;
    const before = structuredClone(initial);
    let next = moveCatalogModel(initial, 'minimax', 'video:recommended', 'backup');
    assert.deepEqual(catalogGroups(next).find(group => group.id).entries.map(entry => entry.id), ['main', 'minimax', 'backup']);
    next = moveCatalogModel(next, 'backup', 'video:recommended', 'main');
    assert.deepEqual(catalogGroups(next).find(group => group.id).entries.map(entry => entry.id), ['backup', 'main', 'minimax']);
    next = moveCatalogModel(next, 'backup', 'video:recommended', 'minimax', 'after');
    assert.deepEqual(catalogGroups(next).find(group => group.id).entries.map(entry => entry.id), ['main', 'minimax', 'backup']);
    assert.throws(() => moveCatalogModel(next, 'main', 'video:recommended', 'missing'), /目标模型/);
    assert.deepEqual(moveCatalogModel(next, 'main', 'video:recommended', 'main'), next);
    assert.equal(next.models[2].presentation.visible, false);
    assert.deepEqual(initial, before);
});

test('unassigned video models stay in the admin workspace but leave canvas choices, and rejoining restores visibility', () => {
    const initial = base();
    initial.catalogMode = 'remote';
    let next = moveCatalogModel(initial, 'main', '');
    assert.equal(next.models[1].presentation.visible, false);
    assert.equal(next.models[1].catalog.enabled, initial.models[1].catalog.enabled);
    assert.ok(catalogGroups(next, { includeHidden: false, includeDisabled: true, includeUnassigned: true })
        .flatMap(group => group.entries).some(entry => entry.id === 'main'));
    assert.ok(!catalogGroups(next, { includeHidden: false }).flatMap(group => group.entries).some(entry => entry.id === 'main'));
    assert.ok(!getCatalogProviderEntries(next, { endpoint: 'https://art.example.com/v1', kind: 'video' }).some(entry => entry.id === 'main'));
    next = moveCatalogModel(next, 'main', 'video:recommended');
    assert.equal(next.models[1].presentation.visible, true);
    assert.ok(getCatalogProviderEntries(next, { endpoint: 'https://art.example.com/v1', kind: 'video' }).some(entry => entry.id === 'main'));
    assert.equal(next.models[1].presentation.routeGroupScope, 'catalog');
    next.models[2].catalog = { model: 'backup', hosts: ['art.example.com'] };
    delete next.models[2].presentation.routeGroupScope;
    const normalized = normalizeCatalogWorkspace(next);
    assert.equal(normalized.models[2].presentation.routeGroupScope, 'catalog', 'Members of a catalog group must not split by API account');
    assert.deepEqual(normalized.models[1].options, initial.models[1].options);
    assert.deepEqual(normalized.models[1].pricing, initial.models[1].pricing);
    assert.deepEqual(normalizeCatalogWorkspace(initial), initial, 'Legacy catalogs without workspace metadata keep standalone models');
});

test('group dragging supports both insertion sides, empty groups and type isolation', () => {
    let config = createCatalogGroup(base(), '', '第二组');
    const second = catalogGroups(config, { includeEmpty: true }).find(group => group.label === '第二组').key;
    config = createCatalogGroup(config, '', '第三组');
    const third = catalogGroups(config, { includeEmpty: true }).find(group => group.label === '第三组').key;
    const keys = config => catalogGroups(config, { kind: 'video', includeEmpty: true }).filter(group => group.id).map(group => group.key);
    let next = placeCatalogGroup(config, third, 'video:recommended', 'before');
    assert.deepEqual(keys(next), [third, 'video:recommended', second]);
    next = placeCatalogGroup(next, third, second, 'after');
    assert.deepEqual(keys(next), ['video:recommended', second, third]);
    assert.deepEqual(placeCatalogGroup(next, second, second), next);
    assert.throws(() => placeCatalogGroup(next, second, 'video:missing'), /不存在/);
    next = createCatalogGroup(next, '', '图片组', 'image');
    const imageGroup = catalogGroups(next, { kind: 'image', includeEmpty: true })[0].key;
    assert.throws(() => placeCatalogGroup(next, second, imageGroup), /相同类型/);
    assert.deepEqual(next.models.map(({ presentation, ...rest }) => rest), config.models.map(({ presentation, ...rest }) => rest));
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
