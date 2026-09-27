import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';
import { projectAdminModelCosts } from '/srv/flow-config/lib/admin-model-costs.mjs';

const { structuredClone } = globalThis;
const specs = [
    { model: 'LongXia-video-seedance2_5-standard-480p-express-PerSecond', label: 'LongXia Seedance 2.5 480p（按秒）',
        resolution: '480p', maxSeconds: 25, unit: 'second', cost: 0.42, art: 0.84, cart: 0.96 },
    { model: 'LongXia-video-seedance2_5-standard-720p-express-PerSecond', label: 'LongXia Seedance 2.5 720p（按秒）',
        resolution: '720p', maxSeconds: 25, unit: 'second', cost: 0.56, art: 1.12, cart: 1.28 },
    { model: 'seedance-2.5-480p', label: 'Seedance 2.5 480p（按次）', resolution: '480p', maxSeconds: 30,
        unit: 'request', cost: 4, art: 8, cart: 9.15 },
    { model: 'seedance-2.5-720p', label: 'Seedance 2.5 720p（按次）', resolution: '720p', maxSeconds: 30,
        unit: 'request', cost: 5, art: 10, cart: 11.43 },
    { model: 'seedance-2.5-1080p', label: 'Seedance 2.5 1080p（按次）', resolution: '1080p', maxSeconds: 30,
        unit: 'request', cost: 6, art: 12, cart: 13.72 }
];
const hosts = ['art.ravenhash.org', 'cart.ravenhash.org', 'video.zhubo.asia'];
const apply = process.argv.includes('--apply');
const dataDir = '/var/lib/flow-config';
const store = createConfigStore({ dataDir });
const current = store.current();
const checkedAt = new Date().toISOString();
const validator = await createValidator({ schemaPath: '/srv/flow-config/schema/model-config.schema.json' });
assert.equal(validator.mode, 'schema');
assert.ok(current);
const config = structuredClone(current.config);
const group = config.models.find(entry => entry.presentation?.routeGroup === 'zhubo-video');
assert.ok(group, 'Recommended video group no longer exists');
const startOrder = Math.max(...config.models.filter(entry => entry.presentation?.routeGroup === 'zhubo-video')
    .map(entry => entry.presentation.routeOrder || 0)) + 1;
const ids = new Map();
for (const [index, spec] of specs.entries()) {
    assert.ok(!config.models.some(entry => entry.catalog?.model === spec.model), 'Model already published');
    const id = `zhubo-video.${spec.model}`;
    ids.set(spec.model, id);
    const longxia = spec.unit === 'second';
    config.models.push({ id, kind: 'video', label: spec.label, channel: '主播视频', route: spec.label, priority: 130,
        match: { model: [`^${spec.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`] },
        catalog: { model: spec.model, hosts, enabled: true },
        presentation: { label: spec.label, routeLabel: spec.label, routeModelLabel: spec.model,
            routeGroup: 'zhubo-video', routeGroupLabel: group.presentation.routeGroupLabel,
            routeGroupOrder: group.presentation.routeGroupOrder, routeOrder: startOrder + index,
            routeGroupAlways: true, routeGroupScope: 'catalog', visible: true },
        parameters: { accepts: ['model', 'prompt', 'seconds', 'ratio', 'resolution', 'image_urls', 'audio_urls'], required: ['model', 'prompt'] },
        options: { duration: { type: 'range', min: 4, max: spec.maxSeconds, integer: true, unit: 'second',
            default: longxia ? 4 : 30, field: 'seconds' },
        ratio: { type: 'enum', values: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'], default: 'adaptive', allowAuto: true, field: 'ratio' },
        resolutionTier: { type: 'fixed', value: spec.resolution, field: 'resolution' } },
        capabilities: { referenceImages: { supported: true, max: 30, maxBytesPerImage: 20 * 1024 * 1024 },
            referenceVideos: { supported: false, max: 0 },
            referenceAudios: { supported: true, max: 10, note: longxia ? 'MP3，每段不超过15MiB' : 'MP3/WAV，每段不超过20MiB' },
            webSearch: { supported: false }, cameraFixed: { supported: false }, generatedAudio: { supported: false }, watermark: { supported: false } },
        prompt: { required: true }, limits: { concurrency: 1 },
        notes: `主播视频；${spec.resolution}；4-${spec.maxSeconds}秒；30图/0视频/10音频；公网URL参考；${longxia ? '按秒计费；MP3每段15MiB' : '按次计费；MP3/WAV每段20MiB'}；比例按公共API文档五种，自动比例在客户端转换` });
}
const checked = validator.validate(config);
assert.equal(checked.ok, true, checked.errors.join('; '));
assert.deepEqual(config.models.slice(0, -specs.length), current.config.models);

function prepareSnapshot(name, change) {
    const target = `${dataDir}/${name}.json`;
    const source = fs.existsSync(target) ? target : `/srv/flow-config/seed/${name}.json`;
    const before = fs.readFileSync(source, 'utf8');
    const value = JSON.parse(before);
    change(value);
    return { target, source, before, value };
}
const snapshots = [
    prepareSnapshot('admin-model-prices', value => {
        assert.equal(value.sites.length, 2);
        for (const site of value.sites) {
            assert.ok(hosts.slice(0, 2).includes(site.host));
            assert.equal(site.currency, 'CNY');
            for (const spec of specs) {
                assert.ok(!site.models.some(model => model.model === spec.model));
                site.models.push({ model: spec.model, status: 'known', active: true, currency: 'CNY',
                    prices: [{ label: spec.resolution, amount: site.host === hosts[0] ? spec.art : spec.cart, unit: spec.unit }] });
            }
            site.checkedAt = checkedAt;
        }
        value.checkedAt = checkedAt;
    }),
    prepareSnapshot('admin-model-costs', value => {
        for (const spec of specs) {
            assert.ok(!value.entries.some(entry => entry.models.includes(spec.model)));
            value.entries.push({ ids: [ids.get(spec.model)], models: [spec.model], supplier: '主播视频',
                status: 'reference', currency: 'CNY', sourceUrl: 'https://video.zhubo.asia/api/video/models', quotedAt: checkedAt,
                prices: [{ label: spec.resolution, amount: spec.cost, unit: spec.unit }],
                note: '公开模型目录实时rates，已核对账户模型列表；目录description旧价未采用，实际账户结算另计' });
        }
        value.checkedAt = checkedAt;
        projectAdminModelCosts(value);
    }),
    prepareSnapshot('admin-model-sources', value => {
        for (const spec of specs) {
            assert.ok(!value.entries.some(entry => entry.ids.includes(ids.get(spec.model))));
            value.entries.push({ ids: [ids.get(spec.model)], models: [spec.model], hosts,
                name: '主播视频', url: 'https://video.zhubo.asia' });
        }
    })
];
assert.equal(store.current().name, current.name, 'CONFIG changed during preparation');
for (const snapshot of snapshots) assert.equal(fs.readFileSync(snapshot.source, 'utf8'), snapshot.before);
let published = null;
let backup = null;
if (apply) {
    backup = `${dataDir}/operations/zhubo-five-${Date.now()}`;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.copyFileSync(store.statePath, `${backup}/state.json`);
    fs.writeFileSync(`${backup}/config.json`, current.text, { mode: 0o600 });
    for (const snapshot of snapshots) {
        fs.writeFileSync(`${backup}/${snapshot.target.split('/').at(-1)}`, snapshot.before, { mode: 0o600 });
        fs.writeFileSync(`${snapshot.target}.zhubo-next`, `${JSON.stringify(snapshot.value, null, 2)}\n`);
        fs.renameSync(`${snapshot.target}.zhubo-next`, snapshot.target);
    }
    published = store.save(config, { actor: 'codex', channel: 'stable', note: 'Add five Zhubo Seedance 2.5 models; double upstream sale; cart 8/7' });
    assert.equal(store.current('preview').name, published.name);
    assert.deepEqual(store.current().config.models.slice(0, -specs.length), current.config.models);
}
console.log(JSON.stringify({ applied: apply, previous: current.name, revision: published?.revision,
    version: published?.name, backup, models: specs, modelCount: config.models.length }));
