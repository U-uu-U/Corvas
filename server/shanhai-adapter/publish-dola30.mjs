import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';
import { projectAdminModelCosts } from '/srv/flow-config/lib/admin-model-costs.mjs';

const { structuredClone } = globalThis;
const apply = process.argv.includes('--apply');
const model = 'oc-model-r5cfh8';
const id = `shanhai-video.${model}`;
const dataDir = '/var/lib/flow-config';
const store = createConfigStore({ dataDir });
const validator = await createValidator({ schemaPath: '/srv/flow-config/schema/model-config.schema.json' });
assert.equal(validator.mode, 'schema');
const checkedAt = new Date().toISOString();
const receipts = [];
const publications = [];
const snapshots = [];

for (const channel of ['stable', 'preview']) {
    const current = store.current(channel);
    assert.ok(current);
    assert.ok(!current.config.models.some(entry => entry.catalog?.model === model), 'Dola 30s already exists');
    const config = structuredClone(current.config);
    const source = config.models.find(entry => entry.catalog?.model === 'oc-model-qbdmeb');
    assert.ok(source?.catalog?.enabled);
    const entry = structuredClone(source);
    Object.assign(entry, { id, label: 'dola（9图30秒）', route: '备用分组2 · dola 30秒',
        match: { model: [`^${model}$`] },
        prompt: { ...source.prompt, maxLength: 20000 },
        notes: '山海 API：固定30秒、720p；六种画幅；最多10张参考图（名称为9图，按上游API能力）；不支持视频/音频参考；按次计费' });
    entry.catalog = { ...source.catalog, model, enabled: true };
    entry.presentation = { ...source.presentation, label: entry.label, routeLabel: entry.label,
        routeModelLabel: model, visible: true, routeOrder: 4 };
    entry.options.duration = { type: 'fixed', value: 30, unit: 'second' };
    entry.options.resolutionTier = { type: 'fixed', value: '720p' };
    entry.capabilities.referenceImages = { supported: true, max: 10 };
    entry.capabilities.referenceVideos = { supported: false, max: 0 };
    entry.capabilities.referenceAudios = { supported: false, max: 0 };
    // A single CONFIG price is scoped to one host; the admin snapshot carries both site prices.
    entry.pricing = { status: 'known', hosts: ['cart.ravenhash.org'], amount: 5.72,
        currency: 'CNY', unit: 'request', kind: 'sale', source: 'cart verified Dola 30s billing', updatedAt: checkedAt };
    config.models.push(entry);
    const validation = validator.validate(config);
    assert.equal(validation.ok, true, validation.errors.join('; '));
    assert.deepEqual(config.models.slice(0, -1), current.config.models);
    assert.equal(store.current(channel).name, current.name, 'CONFIG changed during preparation');
    publications.push({ channel, current, config, entry });
}

function updateSnapshot(name, project, change) {
    const target = `${dataDir}/${name}.json`;
    const source = fs.existsSync(target) ? target : `/srv/flow-config/seed/${name}.json`;
    const before = fs.readFileSync(source, 'utf8');
    const value = JSON.parse(before);
    change(value);
    project(value);
    assert.equal(fs.readFileSync(source, 'utf8'), before, `${name} changed during preparation`);
    snapshots.push({ target, source, before, value });
}

updateSnapshot('admin-model-prices', value => assert.equal(value.sites.length, 2), value => {
    value.checkedAt = checkedAt;
    for (const site of value.sites) {
        const source = site.models.find(entry => entry.model === 'oc-model-qbdmeb');
        assert.ok(source && source.status === 'known');
        assert.ok(!site.models.some(entry => entry.model === model));
        const expected = site.host === 'art.ravenhash.org' ? 5 : 5.72;
        assert.equal(source.prices.length, 1);
        assert.ok(Math.abs(source.prices[0].amount - expected) < 0.00001);
        site.models.push({ ...structuredClone(source), model, active: true });
        site.checkedAt = checkedAt;
    }
});
updateSnapshot('admin-model-costs', projectAdminModelCosts, value => {
    assert.ok(!value.entries.some(entry => entry.models.includes(model)));
    value.entries.push({ ids: [id], models: [model], supplier: '山海', status: 'reference',
        currency: 'CREDITS', prices: [{ label: '720p', amount: 0.9, unit: 'request' }],
        sourceUrl: 'https://shanhai.vnshu.cn/docs', quotedAt: checkedAt,
        note: '鉴权 GET /api/v1/models 核对：0.9山海币/次，与15秒版相同；不等同于人民币售价' });
    value.checkedAt = checkedAt;
});
for (const { channel, current, config, entry } of publications) {
    assert.equal(store.current(channel).name, current.name, 'CONFIG changed before publication');
    const result = apply ? store.save(config, { channel, actor: 'codex', note: 'Add Shanhai Dola 30s; preserve existing channels' }) : {};
    receipts.push({ channel, previous: current.name, revision: result.revision, version: result.name,
        model, limits: entry.capabilities, applied: apply });
}
for (const { target, source, before, value } of snapshots) {
    assert.equal(fs.readFileSync(source, 'utf8'), before, 'Admin snapshot changed before publication');
    if (apply) {
        fs.writeFileSync(`${target}.dola30.tmp`, `${JSON.stringify(value, null, 2)}\n`);
        fs.renameSync(`${target}.dola30.tmp`, target);
    }
}
console.log(JSON.stringify({ receipts, pricesUpdated: apply, costsUpdated: apply }));
