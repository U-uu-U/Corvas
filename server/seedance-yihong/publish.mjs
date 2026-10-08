import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';
import { projectAdminModelCosts } from '/srv/flow-config/lib/admin-model-costs.mjs';

const model = 'seedance-2.5-super';
const id = 'ravenhash-video.seedance25-super';
const label = 'Seedance 2.5 Super';
const hosts = ['art.ravenhash.org', 'cart.ravenhash.org'];
const apply = process.argv.includes('--apply');
const dataDir = '/var/lib/flow-config';
const store = createConfigStore({ dataDir });
const current = store.current();
const validator = await createValidator({ schemaPath: '/srv/flow-config/schema/model-config.schema.json' });
assert.equal(validator.mode, 'schema');
assert.ok(current);
assert.ok(!current.config.models.some(entry => entry.id === id || entry.catalog?.model === model), 'Model already exists');
const config = globalThis.structuredClone(current.config);
const group = config.models.find(entry => entry.presentation?.routeGroup === 'zhubo-video');
assert.ok(group, 'Recommended group not found');
const routeOrder = Math.max(...config.models.filter(entry => entry.presentation?.routeGroup === 'zhubo-video')
    .map(entry => entry.presentation.routeOrder || 0)) + 1;
config.models.push({ id, kind: 'video', label, channel: 'RavenHash视频', route: label, priority: 130,
    match: { model: ['^seedance-2\\.5-super$'] }, catalog: { model, hosts, enabled: true },
    presentation: { label, routeLabel: label, routeModelLabel: model, routeGroup: 'zhubo-video',
        routeGroupLabel: group.presentation.routeGroupLabel, routeGroupOrder: group.presentation.routeGroupOrder,
        routeOrder, routeGroupAlways: true, routeGroupScope: 'catalog', visible: true },
    parameters: { accepts: ['model', 'prompt', 'seconds', 'ratio', 'resolution', 'image_urls', 'video_urls', 'audio_urls'],
        required: ['model', 'prompt'] },
    options: { duration: { type: 'range', min: 5, max: 30, integer: true, unit: 'second', default: 5, field: 'seconds' },
        ratio: { type: 'enum', values: ['adaptive', '16:9', '9:16', '1:1', '3:4', '4:3', '21:9'],
            default: 'adaptive', allowAuto: true, field: 'ratio' },
        resolutionTier: { type: 'fixed', value: '720p', field: 'resolution' } },
    capabilities: { referenceImages: { supported: true, max: 30 }, referenceVideos: { supported: true, max: 10 },
        referenceAudios: { supported: true, max: 10 }, face: { supported: true },
        webSearch: { supported: false }, cameraFixed: { supported: false },
        generatedAudio: { supported: false }, watermark: { supported: false } },
    parameterRules: { version: 1, rules: [] }, prompt: { required: true }, limits: { concurrency: 1 },
    notes: '720p；5-30秒整数；30图/10视频/10音频参考；参考素材使用HTTPS链接；按秒计费' });
const validated = validator.validate(config);
assert.equal(validated.ok, true, validated.errors.join('; '));
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
                prices: [{ label: '720p', amount: 0.78, unit: 'second' }] });
            site.checkedAt = checkedAt;
        }
        value.checkedAt = checkedAt;
    }),
    snapshot('admin-model-costs', value => {
        assert.ok(!value.entries.some(entry => entry.models.includes(model)));
        value.entries.push({ ids: [id], models: [model], supplier: 'Yihong', status: 'reference', currency: 'CNY',
            sourceUrl: 'https://yihongapi.com/api/pricing', quotedAt: checkedAt,
            prices: [{ label: '720p', amount: 0.38, unit: 'second' }],
            note: '公开计费表达式每秒0.052054794520547946，按站点展示汇率7.3折合0.38元；未以付费生成验证实际结算' });
        value.checkedAt = checkedAt;
        projectAdminModelCosts(value);
    }),
    snapshot('admin-model-sources', value => {
        assert.ok(!value.entries.some(entry => entry.ids.includes(id)));
        value.entries.push({ ids: [id], models: [model], hosts, name: 'Yihong', url: 'https://yihongapi.com' });
    })
];
assert.equal(store.current().name, current.name, 'Published config changed');
for (const entry of snapshots) assert.equal(fs.readFileSync(entry.source, 'utf8'), entry.before, 'Price snapshot changed');
let published = null;
let backup = null;
if (apply) {
    backup = `${dataDir}/operations/yihong-super-${Date.now()}`;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.copyFileSync(store.statePath, `${backup}/state.json`);
    fs.writeFileSync(`${backup}/config.json`, current.text, { mode: 0o600 });
    for (const entry of snapshots) {
        fs.writeFileSync(`${backup}/${entry.name}.json`, entry.before, { mode: 0o600 });
        fs.writeFileSync(`${entry.target}.yihong-next`, `${JSON.stringify(entry.value, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(`${entry.target}.yihong-next`, entry.target);
    }
    published = store.save(config, { actor: 'codex', channel: 'stable', note: 'Add Seedance 2.5 Super; art/cart CNY 0.78 per second' });
    assert.equal(store.current('preview').name, published.name);
    assert.deepEqual(store.current().config.models.slice(0, -1), current.config.models);
}
console.log(JSON.stringify({ applied: apply, previous: current.name, version: published?.name,
    revision: published?.revision, model, id, salePerSecond: 0.78, backup, modelCount: config.models.length }));
