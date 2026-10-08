import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';
import { projectAdminModelCosts } from '/srv/flow-config/lib/admin-model-costs.mjs';

const model = 'b_seedance_v2.0';
const id = 'ravenhash-video.seedance20-direct';
const label = 'Seedance 2.0 15秒';
const hosts = ['art.ravenhash.org', 'cart.ravenhash.org'];
const dataDir = '/var/lib/flow-config';
const apply = process.argv.includes('--apply');
const store = createConfigStore({ dataDir });
const current = store.current();
const config = globalThis.structuredClone(current.config);
assert.ok(!config.models.some(entry => entry.id === id || entry.catalog?.model === model), 'Model already exists');
let group = config.catalogGroups.find(entry => entry.id === 'seedance20-backup');
if (!group) {
    group = { id: 'seedance20-backup', kind: 'video', label: 'Seedance 2.0 备用渠道', order: 26, scope: 'catalog', description: '' };
    config.catalogGroups.push(group);
}
config.models.push({ id, kind: 'video', label, route: label, channel: 'RavenHash视频', priority: 130,
    match: { model: ['^b_seedance_v2\\.0$'] }, catalog: { model, hosts, enabled: true },
    presentation: { label, routeLabel: label, routeModelLabel: model, routeGroup: group.id,
        routeGroupLabel: group.label, routeGroupOrder: group.order, routeOrder: 1, routeGroupAlways: true,
        routeGroupScope: 'catalog', visible: true },
    parameters: { accepts: ['model', 'prompt', 'seconds', 'duration', 'aspect_ratio', 'ratio', 'reference_images', 'image_urls', 'images'],
        required: ['model', 'prompt'] },
    options: { duration: { type: 'fixed', value: 15, unit: 'second', field: 'seconds' },
        ratio: { type: 'enum', values: ['9:16', '16:9'], default: '9:16', field: 'aspect_ratio' },
        resolutionTier: { type: 'unsupported', reason: '接口未提供分辨率选择' } },
    capabilities: { referenceImages: { supported: true, max: 9 }, referenceVideos: { supported: false, max: 0 },
        referenceAudios: { supported: false, max: 0 }, webSearch: { supported: false }, cameraFixed: { supported: false },
        generatedAudio: { supported: false }, watermark: { supported: false } },
    parameterRules: { version: 1, rules: [] }, prompt: { required: true }, limits: { concurrency: 1 },
    notes: '固定15秒；16:9/9:16；最多9张参考图；不支持音视频参考；按次计费；接口未声明输出分辨率' });
const validator = await createValidator({ schemaPath: '/srv/flow-config/schema/model-config.schema.json' });
assert.equal(validator.mode, 'schema');
const checked = validator.validate(config);
assert.equal(checked.ok, true, checked.errors.join('; '));
assert.deepEqual(config.models.slice(0, -1), current.config.models);
const checkedAt = new Date().toISOString();
function snapshot(name, update) {
    const target = `${dataDir}/${name}.json`;
    const source = fs.existsSync(target) ? target : `/srv/flow-config/seed/${name}.json`;
    const before = fs.readFileSync(source, 'utf8');
    const value = JSON.parse(before);
    update(value);
    return { name, source, target, before, value };
}
const snapshots = [
    snapshot('admin-model-prices', value => {
        assert.equal(value.sites.length, 2);
        for (const site of value.sites) {
            assert.ok(hosts.includes(site.host));
            assert.equal(site.currency, 'CNY');
            assert.ok(!site.models.some(entry => entry.model === model));
            site.models.push({ model, status: 'known', active: true, currency: 'CNY',
                prices: [{ label: '15秒', amount: 2, unit: 'request' }] });
            site.checkedAt = checkedAt;
        }
        value.checkedAt = checkedAt;
    }),
    snapshot('admin-model-costs', value => {
        assert.ok(!value.entries.some(entry => entry.models?.includes(model)));
        value.entries.push({ ids: [id], models: [model], supplier: '数值任务视频接口', status: 'unknown',
            sourceUrl: 'http://38.76.169.86:8080', prices: [],
            note: '文档未提供实际型号成本；示例预扣2点不能作为当前型号成本报价' });
        projectAdminModelCosts(value);
    }),
    snapshot('admin-model-sources', value => {
        assert.ok(!value.entries.some(entry => entry.ids?.includes(id)));
        value.entries.push({ ids: [id], models: [model], hosts, name: '数值任务视频接口', url: 'http://38.76.169.86:8080' });
    })
];
assert.equal(store.current().name, current.name, 'CONFIG changed');
for (const entry of snapshots) assert.equal(fs.readFileSync(entry.source, 'utf8'), entry.before, 'Price snapshot changed');
let published = null;
let backup = null;
if (apply) {
    backup = `${dataDir}/operations/seedance-direct-${Date.now()}`;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.copyFileSync(store.statePath, `${backup}/state.json`);
    fs.writeFileSync(`${backup}/config.json`, current.text, { mode: 0o600 });
    for (const entry of snapshots) {
        fs.writeFileSync(`${backup}/${entry.name}.json`, entry.before, { mode: 0o600 });
        fs.writeFileSync(`${entry.target}.direct-next`, JSON.stringify(entry.value, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(`${entry.target}.direct-next`, entry.target);
    }
    published = store.save(config, { actor: 'codex', channel: 'stable', note: 'Add fixed 15s Seedance 2.0; art/cart CNY 2 per request' });
    assert.equal(store.current('preview').name, published.name);
    assert.deepEqual(store.current().config.models.slice(0, -1), current.config.models);
}
console.log(JSON.stringify({ applied: apply, previous: current.name, version: published?.name,
    revision: published?.revision, model, saleCny: 2, unit: 'request', group: group.id, backup }));
