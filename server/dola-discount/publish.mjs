import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';
import { projectAdminModelCosts } from '/srv/flow-config/lib/admin-model-costs.mjs';
import { model, id, hosts, addCatalogModel } from './catalog.mjs';

const dataDir = '/var/lib/flow-config';
const apply = process.argv.includes('--apply');
const store = createConfigStore({ dataDir });
const current = store.current();
const config = addCatalogModel(current.config);
const validator = await createValidator({ schemaPath: '/srv/flow-config/schema/model-config.schema.json' });
assert.equal(validator.mode, 'schema');
const checked = validator.validate(config);
assert.equal(checked.ok, true, checked.errors.join('; '));
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
                prices: [{ label: '4-30秒', amount: 10, unit: 'request' }] });
            site.checkedAt = checkedAt;
        }
        value.checkedAt = checkedAt;
    }),
    snapshot('admin-model-costs', value => {
        assert.ok(!value.entries.some(entry => entry.models?.includes(model)));
        value.entries.push({ ids: [id], models: [model], supplier: 'Dola特价渠道', status: 'reference',
            currency: 'CNY', sourceUrl: 'http://160.202.238.97:3000', quotedAt: checkedAt,
            prices: [{ label: '每条', amount: 4, unit: 'request' }],
            note: '用户确认4元/条，按2.5倍销售；未套用自建池文档中的3/4元分档；未提交收费生成验证最终账单' });
        value.checkedAt = checkedAt;
        projectAdminModelCosts(value);
    }),
    snapshot('admin-model-sources', value => {
        assert.ok(!value.entries.some(entry => entry.ids?.includes(id)));
        value.entries.push({ ids: [id], models: [model], hosts, name: 'Dola特价渠道', url: 'http://160.202.238.97:3000' });
    })
];
assert.equal(store.current().name, current.name, 'CONFIG changed');
for (const entry of snapshots) assert.equal(fs.readFileSync(entry.source, 'utf8'), entry.before, 'Admin snapshot changed');
let published = null;
let backup = null;
if (apply) {
    backup = `${dataDir}/operations/dola-discount-${Date.now()}`;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.copyFileSync(store.statePath, `${backup}/state.json`);
    fs.writeFileSync(`${backup}/config.json`, current.text, { mode: 0o600 });
    for (const entry of snapshots) {
        fs.writeFileSync(`${backup}/${entry.name}.json`, entry.before, { mode: 0o600 });
        fs.writeFileSync(`${entry.target}.dola-next`, JSON.stringify(entry.value, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(`${entry.target}.dola-next`, entry.target);
    }
    published = store.save(config, { actor: 'codex', channel: 'stable', note: 'Add Dola 2.5 discount; art/cart CNY 10 per request' });
    assert.equal(store.current('preview').name, published.name);
    assert.deepEqual(store.current().config.models.slice(0, -1), current.config.models);
}
console.log(JSON.stringify({ applied: apply, previous: current.name, version: published?.name,
    revision: published?.revision, model, saleCny: 10, unit: 'request', group: config.models.at(-1).presentation.routeGroup, backup }));
