import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';
import { projectAdminModelCosts } from '/srv/flow-config/lib/admin-model-costs.mjs';
import { hosts, saleCny } from './catalog.mjs';
import { existingSpec, newSpec, updateSeedance20Catalog } from './seedance20-catalog.mjs';

const dataDir = '/var/lib/flow-config';
const apply = process.argv.includes('--apply');
const store = createConfigStore({ dataDir });
const current = store.current();
assert.ok(current);
const config = updateSeedance20Catalog(current.config);
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
            const existing = site.models.find(entry => entry.model === existingSpec.model);
            assert.ok(existing && existing.prices.length === 1 && existing.prices[0].amount === 3.6 && existing.prices[0].unit === 'request');
            existing.active = true;
            assert.ok(!site.models.some(entry => entry.model === newSpec.model));
            site.models.push({ model: newSpec.model, status: 'known', active: true, currency: 'CNY',
                prices: [{ label: '720p', amount: saleCny(newSpec), unit: 'request' }] });
            site.checkedAt = checkedAt;
        }
        value.checkedAt = checkedAt;
    }),
    snapshot('admin-model-costs', value => {
        assert.ok(!value.entries.some(entry => entry.models?.includes(newSpec.model)));
        value.entries.push({ ids: [newSpec.id], models: [newSpec.model], supplier: '飞拓', status: 'reference', currency: 'CNY',
            sourceUrl: 'https://feituokuajing.com/api/open/v1/models', quotedAt: checkedAt,
            prices: [{ label: '720p', amount: newSpec.costCny, unit: 'request' }],
            note: '鉴权模型目录报价，按用户指定成本乘3销售；上游标注量大长期稳定、不保售后；未提交收费生成验证最终账单' });
        value.checkedAt = checkedAt;
        projectAdminModelCosts(value);
    }),
    snapshot('admin-model-sources', value => {
        assert.ok(!value.entries.some(entry => entry.ids?.includes(newSpec.id)));
        value.entries.push({ ids: [newSpec.id], models: [newSpec.model], hosts, name: '飞拓', url: 'https://feituokuajing.com' });
    })
];
assert.equal(store.current().name, current.name, 'CONFIG changed');
for (const entry of snapshots) assert.equal(fs.readFileSync(entry.source, 'utf8'), entry.before, 'Admin snapshot changed');
let published = null;
let backup = null;
if (apply) {
    backup = `${dataDir}/operations/feituo20-${Date.now()}`;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.copyFileSync(store.statePath, `${backup}/state.json`);
    fs.writeFileSync(`${backup}/config.json`, current.text, { mode: 0o600 });
    const written = [];
    try {
        for (const entry of snapshots) {
            fs.writeFileSync(`${backup}/${entry.name}.json`, entry.before, { mode: 0o600 });
            fs.writeFileSync(`${entry.target}.feituo20-next`, JSON.stringify(entry.value, null, 2)+'\n', { mode: 0o600 });
            fs.renameSync(`${entry.target}.feituo20-next`, entry.target);
            written.push(entry);
        }
        published = store.save(config, { actor: 'codex', channel: 'stable', note: 'Restore Feituo 933 and add Seedance 2.0 long-term; CNY 3.60/7.50 per request' });
    } catch (error) {
        for (const entry of written) {
            if (JSON.stringify(JSON.parse(fs.readFileSync(entry.target, 'utf8'))) === JSON.stringify(entry.value)) {
                if (entry.existed) fs.writeFileSync(entry.target, entry.before, { mode: 0o600 });
                else fs.unlinkSync(entry.target);
            }
        }
        throw error;
    }
    assert.equal(store.current('preview').name, published.name);
}
console.log(JSON.stringify({ applied: apply, previous: current.name, version: published?.name, revision: published?.revision,
    models: [existingSpec, newSpec].map(spec => ({ model: spec.model, saleCny: saleCny(spec), unit: 'request' })),
    group: newSpec.group, backup }));
