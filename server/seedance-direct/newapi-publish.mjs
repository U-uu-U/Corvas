import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';

const store = createConfigStore({ dataDir: '/var/lib/flow-config' });
const before = store.current();
const config = globalThis.structuredClone(before.config);
const id = 'ravenhash-ai-video.seedance20-direct';
const source = config.models.find(entry => entry.id === 'ravenhash-video.seedance20-direct');
assert.ok(source && source.catalog.model === 'b_seedance_v2.0');
assert.ok(!config.models.some(entry => entry.id === id));
const entry = globalThis.structuredClone(source);
entry.id = id;
entry.channel = 'RavenHash AI';
entry.catalog.hosts = ['ai.ravenhash.org'];
entry.catalog.enabled = true;
entry.match.endpoint = '^https://ai\\.ravenhash\\.org(?::443)?(?:/|$)';
entry.pricing = { status: 'known', hosts: ['ai.ravenhash.org'], amount: 2, currency: 'CNY', unit: 'request',
    kind: 'sale', source: 'ai.ravenhash.org model price and group ratio', updatedAt: new Date().toISOString() };
delete entry.salePrices;
delete entry.generationHealth;
config.models.push(entry);
if (config.catalogScope?.kinds?.includes('video') && !config.catalogScope.hosts.includes('ai.ravenhash.org')) {
    config.catalogScope.hosts.push('ai.ravenhash.org');
}
const validator = await createValidator({ schemaPath: '/srv/flow-config/schema/model-config.schema.json' });
assert.equal(validator.mode, 'schema');
const checked = validator.validate(config);
assert.equal(checked.ok, true, checked.errors.join('; '));
assert.deepEqual(config.models.slice(0, -1), before.config.models);
assert.equal(store.current().name, before.name, 'Published config changed');
const backup = `/var/lib/flow-config/operations/ai-seedance20-${Date.now()}`;
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
fs.writeFileSync(`${backup}/before.json`, before.text, { mode: 0o600 });
const saved = store.save(config, { actor: 'codex', note: 'Add Seedance 2.0 15s on ai.ravenhash.org; CNY 2/request' });
assert.deepEqual(store.current().config.models.slice(0, -1), before.config.models);
console.log(JSON.stringify({ revision: saved.revision, version: saved.name, id, model: entry.catalog.model,
    hosts: entry.catalog.hosts, saleCny: 2, backup }));
