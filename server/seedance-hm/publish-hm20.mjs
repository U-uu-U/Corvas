import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';
import { projectAdminModelCosts } from '/srv/flow-config/lib/admin-model-costs.mjs';

const specs = [
    { id: 'ravenhash-video.hm-fast-813', model: 'SD2.0FAST813', label: 'HM-Seedance 2.0 Fast 813', refs: [8, 1, 3],
        prices: [['720p', 1.3, 3.9, 4.46], ['1080p', 1.5, 4.5, 5.15], ['2k', 1.7, 5.1, 5.83]] },
    { id: 'ravenhash-video.hm-mini-503', model: 'SD2.0MINI503', label: 'HM-Seedance 2.0 Mini 503', refs: [5, 0, 3],
        prices: [['720p', 0.9, 2.7, 3.09]] },
    { id: 'ravenhash-video.hm-seedance-933', model: 'seedance_v2.0-933', label: 'HM-Seedance 2.0 933', refs: [9, 3, 3],
        prices: [['720p', 1, 3, 3.43]], existing: true }
];
const hosts = ['art.ravenhash.org', 'cart.ravenhash.org'];
const ids = new Set(specs.map(spec => spec.id));
const models = new Set(specs.map(spec => spec.model));
const group = { id: 'hm-seedance20', kind: 'video', label: 'Seedance 2.0 HM', order: 25, scope: 'catalog', description: '' };
const apply = process.argv.includes('--apply');
const dataDir = '/var/lib/flow-config';
const store = createConfigStore({ dataDir });
const current = store.current();
const config = globalThis.structuredClone(current.config);
assert.ok(!config.catalogGroups.some(entry => entry.id === group.id), 'HM group already exists');
config.catalogGroups.push(group);
for (const [index, spec] of specs.entries()) {
    const prior = config.models.filter(entry => entry.catalog?.model === spec.model);
    assert.equal(prior.length, spec.existing ? 1 : 0, 'Unexpected catalog model count');
    const entry = prior[0] || { id: spec.id, kind: 'video', priority: 130 };
    assert.equal(entry.id, spec.id);
    delete entry.pricing;
    const [image, video, audio] = spec.refs;
    Object.assign(entry, { label: spec.label, channel: 'RavenHash视频', route: spec.label,
        match: { model: [`^${spec.model.replaceAll('.', '\\.')}$`] },
        catalog: { model: spec.model, hosts, enabled: true },
        presentation: { label: spec.label, routeLabel: spec.label, routeModelLabel: spec.model,
            routeGroup: group.id, routeGroupLabel: group.label, routeGroupOrder: group.order,
            routeOrder: index + 1, routeGroupAlways: true, routeGroupScope: 'catalog', visible: true },
        parameters: { accepts: ['model', 'prompt', 'seconds', 'ratio', 'resolution', 'image_urls',
            ...(video ? ['video_urls'] : []), 'audio_urls'], required: ['model', 'prompt'] },
        options: { duration: { type: 'range', min: 4, max: 15, integer: true, unit: 'second', default: 15, field: 'seconds' },
            resolutionTier: { type: 'enum', values: spec.prices.map(price => price[0]), default: '720p', field: 'resolution' },
            ratio: { type: 'enum', values: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'], default: 'adaptive', allowAuto: true, field: 'ratio' } },
        capabilities: { referenceImages: { supported: true, max: image }, referenceVideos: { supported: video > 0, max: video },
            referenceAudios: { supported: true, max: audio },
            ...(spec.existing ? { face: { supported: false, reason: '人脸参考受限' } } : {}),
            webSearch: { supported: false }, cameraFixed: { supported: false }, generatedAudio: { supported: false }, watermark: { supported: false } },
        parameterRules: { version: 1, rules: [] }, prompt: { required: true }, limits: { concurrency: 1 },
        notes: `4-15秒；${spec.prices.map(price => price[0]).join('/')}；${image}图/${video}视频/${audio}音频；按次计费${spec.existing ? '；人脸参考受限' : ''}` });
    if (!spec.existing) config.models.push(entry);
}
const validator = await createValidator({ schemaPath: '/srv/flow-config/schema/model-config.schema.json' });
assert.equal(validator.mode, 'schema');
const checked = validator.validate(config);
assert.equal(checked.ok, true, checked.errors.join('; '));
const unrelated = value => value.models.filter(entry => !models.has(entry.catalog?.model));
assert.deepEqual(unrelated(config), unrelated(current.config));
const checkedAt = new Date().toISOString();
function snapshot(name, update) {
    const target = `${dataDir}/${name}.json`;
    const source = fs.existsSync(target) ? target : `/srv/flow-config/seed/${name}.json`;
    const before = fs.readFileSync(source, 'utf8');
    const value = JSON.parse(before);
    update(value);
    return { name, source, target, before, value };
}
function preserveOtherEntries(value) {
    value.entries = value.entries.flatMap(entry => {
        if (!entry.ids?.some(id => ids.has(id)) && !entry.models?.some(model => models.has(model))) return [entry];
        const remaining = { ...entry,
            ...(entry.ids ? { ids: entry.ids.filter(id => !ids.has(id)) } : {}),
            ...(entry.models ? { models: entry.models.filter(model => !models.has(model)) } : {}) };
        return remaining.ids?.length || remaining.models?.length ? [remaining] : [];
    });
}
const snapshots = [
    snapshot('admin-model-prices', value => {
        assert.equal(value.sites.length, 2);
        for (const site of value.sites) {
            assert.ok(hosts.includes(site.host));
            assert.equal(site.currency, 'CNY');
            const amountIndex = site.host === hosts[0] ? 2 : 3;
            for (const spec of specs) {
                const price = { model: spec.model, status: 'known', active: true, currency: 'CNY',
                    prices: spec.prices.map(row => ({ label: row[0], amount: row[amountIndex], unit: 'request' })) };
                const index = site.models.findIndex(entry => entry.model === spec.model);
                if (index < 0) site.models.push(price);
                else site.models[index] = price;
            }
            site.checkedAt = checkedAt;
        }
        value.checkedAt = checkedAt;
    }),
    snapshot('admin-model-costs', value => {
        preserveOtherEntries(value);
        for (const spec of specs) value.entries.push({ ids: [spec.id], models: [spec.model], supplier: '主播视频',
            status: 'reference', currency: 'CNY', sourceUrl: 'https://video.zhubo.asia/v1/pricing', quotedAt: checkedAt,
            prices: spec.prices.map(row => ({ label: row[0], amount: row[1], unit: 'request' })),
            note: '已核对两站渠道账号的鉴权价表；未提交付费生成验证实际结算' });
        value.checkedAt = checkedAt;
        projectAdminModelCosts(value);
    }),
    snapshot('admin-model-sources', value => {
        preserveOtherEntries(value);
        for (const spec of specs) value.entries.push({ ids: [spec.id], models: [spec.model], hosts,
            name: '主播视频', url: 'https://video.zhubo.asia' });
    })
];
assert.equal(store.current().name, current.name, 'CONFIG changed');
for (const entry of snapshots) assert.equal(fs.readFileSync(entry.source, 'utf8'), entry.before, 'Admin snapshot changed');
let published = null;
let backup = null;
if (apply) {
    backup = `${dataDir}/operations/hm20-${Date.now()}`;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.copyFileSync(store.statePath, `${backup}/state.json`);
    fs.writeFileSync(`${backup}/config.json`, current.text, { mode: 0o600 });
    for (const entry of snapshots) {
        fs.writeFileSync(`${backup}/${entry.name}.json`, entry.before, { mode: 0o600 });
        fs.writeFileSync(`${entry.target}.hm20-next`, JSON.stringify(entry.value, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(`${entry.target}.hm20-next`, entry.target);
    }
    published = store.save(config, { actor: 'codex', channel: 'stable', note: 'Add HM Fast 813 and Mini 503; reprice 933; art x3, cart x8/7' });
    assert.equal(store.current('preview').name, published.name);
    assert.deepEqual(unrelated(store.current().config), unrelated(current.config));
}
console.log(JSON.stringify({ applied: apply, previous: current.name, version: published?.name,
    revision: published?.revision, group, models: specs.map(({ model, label, prices }) => ({ model, label, prices })), backup }));
