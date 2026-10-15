import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import { createConfigStore } from '/srv/flow-config/lib/store.mjs';
import { createValidator } from '/srv/flow-config/lib/validate.mjs';
import { addNanoBanana, nanoBananaEntry } from './catalog.mjs';

const store = createConfigStore({ dataDir: '/var/lib/flow-config' });
const before = store.current();
const config = addNanoBanana(before.config, { status: 'known', hosts: ['ai.ravenhash.org'], amount: 0.085,
    currency: 'CNY', unit: 'request', kind: 'sale', source: 'ai.ravenhash.org model price and group ratio', updatedAt: new Date().toISOString() });
const validator = await createValidator({ schemaPath: '/srv/flow-config/schema/model-config.schema.json' });
const checked = validator.validate(config);
assert.equal(checked.ok, true, checked.errors.join('; '));
assert.deepEqual(config.models.slice(0, -1), before.config.models);
assert.equal(store.current().name, before.name, 'Published config changed during preparation');
const backup = `/var/lib/flow-config/operations/nano-banana-${Date.now()}`;
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
fs.writeFileSync(`${backup}/before.json`, before.text, { mode: 0o600 });
const saved = store.save(config, { actor: 'codex', note: 'Add Nano Banana 2.1 native Gemini image route on ai.ravenhash.org' });
assert.deepEqual(store.current().config.models.filter(entry => entry.id !== nanoBananaEntry.id), before.config.models);
console.log(JSON.stringify({ revision: saved.revision, version: saved.name, id: nanoBananaEntry.id, backup }));
