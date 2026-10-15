import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';
import { projectAdminModelCosts } from '/srv/flow-config/lib/admin-model-costs.mjs';
import { addCatalogModel, model, id, hosts } from './catalog.mjs';

const apply = process.argv.includes('--apply');
const dataDir = '/var/lib/flow-config';
const store = createConfigStore({ dataDir });
const current = store.current();
assert.ok(current);
const config = addCatalogModel(current.config);
const validator = await createValidator({ schemaPath: '/srv/flow-config/schema/model-config.schema.json' });
assert.equal(validator.mode, 'schema');
const valid = validator.validate(config);
assert.equal(valid.ok, true, valid.errors.join('; '));
const checkedAt = new Date().toISOString();
function snapshot(name, update) {
    const target = `${dataDir}/${name}.json`;
    const source = fs.existsSync(target) ? target : `/srv/flow-config/seed/${name}.json`;
    const before = fs.readFileSync(source, 'utf8');
    const value = JSON.parse(before);
    update(value);
    return { name, target, source, before, value };
}
const snapshots = [
    snapshot('admin-model-prices', value => {
        assert.equal(value.sites.length, 2);
        for (const site of value.sites) {
            assert.ok(hosts.includes(site.host));
            assert.equal(site.currency, 'CNY');
            assert.ok(!site.models.some(entry => entry.model === model));
            site.models.push({ model, status: 'known', active: true, currency: 'CNY',
                prices: [{ label: '720p', amount: 4, unit: 'request' }] });
            site.checkedAt = checkedAt;
        }
        value.checkedAt = checkedAt;
    }),
    snapshot('admin-model-costs', value => {
        assert.ok(!value.entries.some(entry => entry.models.includes(model)));
        value.entries.push({ ids: [id], models: [model], supplier: 'Yihong', status: 'reference', currency: 'CNY',
            sourceUrl: 'https://yihongapi.com/api/pricing', quotedAt: checkedAt,
            prices: [{ label: '720p', amount: 0.8, unit: 'request' }],
            note: '公开价表按次0.10958904109589042，按站点显示汇率7.3折合0.80元；未以付费生成验证结算' });
        value.checkedAt = checkedAt;
        projectAdminModelCosts(value);
    }),
    snapshot('admin-model-sources', value => {
        assert.ok(!value.entries.some(entry => entry.ids.includes(id)));
        value.entries.push({ ids: [id], models: [model], hosts, name: 'Yihong', url: 'https://yihongapi.com' });
    })
];
assert.equal(store.current().name, current.name, 'Published config changed');
for (const entry of snapshots) assert.equal(fs.readFileSync(entry.source, 'utf8'), entry.before, 'Private catalog changed');
let published = null;
let backup = null;
if (apply) {
    backup = `${dataDir}/operations/yihong-cheap-${Date.now()}`;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.copyFileSync(store.statePath, `${backup}/state.json`);
    fs.writeFileSync(`${backup}/config.json`, current.text, { mode: 0o600 });
    for (const entry of snapshots) {
        fs.writeFileSync(`${backup}/${entry.name}.json`, entry.before, { mode: 0o600 });
        fs.writeFileSync(`${entry.target}.yihong-cheap-next`, `${JSON.stringify(entry.value, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(`${entry.target}.yihong-cheap-next`, entry.target);
    }
    published = store.save(config, { actor: 'codex', channel: 'stable', note: 'Add Seedance 2.5 Cheap; art/cart CNY 4/request' });
    assert.equal(store.current('preview').name, published.name);
    assert.deepEqual(store.current().config.models.slice(0, -1), current.config.models);
}
console.log(JSON.stringify({ applied: apply, previous: current.name, version: published?.name,
    revision: published?.revision, model, id, sale: 4, unit: 'request', backup, modelCount: config.models.length }));
