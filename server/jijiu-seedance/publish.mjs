import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';
import { projectAdminModelCosts } from '/srv/flow-config/lib/admin-model-costs.mjs';
import { spec, hosts, addCatalogModel } from './catalog.mjs';

const dataDir = '/var/lib/flow-config';
const apply = process.argv.includes('--apply');
const store = createConfigStore({ dataDir });
const current = store.current();
assert.ok(current);
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
    return { name, source, target, before, value, existed: fs.existsSync(target) };
}

const snapshots = [
    snapshot('admin-model-prices', value => {
        assert.equal(value.sites.length, 2);
        for (const site of value.sites) {
            assert.ok(hosts.includes(site.host));
            assert.equal(site.currency, 'CNY');
            assert.ok(!site.models.some(entry => entry.model === spec.model));
            site.models.push({ model: spec.model, status: 'known', active: true, currency: 'CNY',
                prices: [{ label: '720p', amount: spec.saleCny, unit: 'request' }] });
            site.checkedAt = checkedAt;
        }
        value.checkedAt = checkedAt;
    }),
    snapshot('admin-model-costs', value => {
        assert.ok(!value.entries.some(entry => entry.models?.includes(spec.model)));
        value.entries.push({ ids: [spec.id], models: [spec.model], supplier: '极九', status: 'reference', currency: 'CNY',
            sourceUrl: spec.origin + '/api/pricing', quotedAt: checkedAt,
            prices: [{ label: '720p', amount: spec.referenceCostCny, unit: 'request' }],
            note: '上游公开目录5.50元/次；两站用户指定售价11元/次；未提交收费生成验证最终账单' });
        value.checkedAt = checkedAt;
        projectAdminModelCosts(value);
    }),
    snapshot('admin-model-sources', value => {
        assert.ok(!value.entries.some(entry => entry.ids?.includes(spec.id)));
        value.entries.push({ ids: [spec.id], models: [spec.model], hosts, name: '极九', url: spec.origin });
    }),
    snapshot('admin-balance-accounts', value => {
        assert.ok(!value.accounts.some(entry => entry.id === 'jijiu-art' || entry.url === spec.origin));
        value.accounts.push({ id: 'jijiu-art', name: '极九', account: 'Seedance 2.5 满参线路三', url: spec.origin, linkOnly: true });
    })
];

assert.equal(store.current().name, current.name, 'CONFIG changed');
for (const entry of snapshots) assert.equal(fs.readFileSync(entry.source, 'utf8'), entry.before, 'Admin snapshot changed');
let published = null;
let backup = null;
if (apply) {
    backup = `${dataDir}/operations/jijiu-route3-${Date.now()}`;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.copyFileSync(store.statePath, `${backup}/state.json`);
    fs.writeFileSync(`${backup}/config.json`, current.text, { mode: 0o600 });
    for (const entry of snapshots) {
        fs.writeFileSync(`${backup}/${entry.name}.json`, entry.before, { mode: 0o600 });
        fs.writeFileSync(`${entry.target}.jijiu-next`, JSON.stringify(entry.value, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(`${entry.target}.jijiu-next`, entry.target);
    }
    try {
        published = store.save(config, { actor: 'codex', channel: 'stable', note: 'Add Seedance 2.5 full route 3; art/cart CNY 11/request' });
    } catch (error) {
        for (const entry of snapshots) {
            if (JSON.stringify(JSON.parse(fs.readFileSync(entry.target, 'utf8'))) === JSON.stringify(entry.value)) {
                if (entry.existed) fs.writeFileSync(entry.target, entry.before, { mode: 0o600 });
                else fs.unlinkSync(entry.target);
            }
        }
        throw error;
    }
    assert.equal(store.current('preview').name, published.name);
    assert.deepEqual(store.current().config.models.slice(0, -1), current.config.models);
}
console.log(JSON.stringify({ applied: apply, previous: current.name, version: published?.name,
    revision: published?.revision, model: spec.model, saleCny: spec.saleCny, unit: 'request', group: spec.group, backup }));
