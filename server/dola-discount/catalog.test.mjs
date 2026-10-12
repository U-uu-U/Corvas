import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { createRequire } from 'node:module';
import { createValidator } from '../../configserver/lib/validate.mjs';
import { resolveModelConfigEntry } from '../../src/model-config-capabilities.js';
import { model, id, hosts, addCatalogModel } from './catalog.mjs';

const require = createRequire(import.meta.url);
const { validateModelParameterRequest } = require('../../shared/model-parameter-rules.cjs');
const { isSeedanceVideoModel } = require('../../electron-main/video-provider-adapters.js');

test('Dola catalog resolves exact public alias and preserves current models', async () => {
    const seed = JSON.parse(fs.readFileSync(new URL('../../configserver/seed/model-config.default.json', import.meta.url), 'utf8'));
    seed.catalogGroups ||= [];
    if (!seed.catalogGroups.some(group => group.id === 'seedance25-backup')) {
        seed.catalogGroups.push({ id: 'seedance25-backup', kind: 'video', label: 'Seedance 2.5 backup', order: 30, scope: 'catalog' });
    }
    const config = addCatalogModel(seed);
    const validator = await createValidator({ schemaPath: fileURLToPath(new URL('../../configserver/schema/model-config.schema.json', import.meta.url)) });
    const result = validator.validate(config);
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.deepEqual(config.models.slice(0, -1), seed.models);
    assert.equal(isSeedanceVideoModel(model), false);
    for (const host of hosts) {
        const entry = resolveModelConfigEntry(config, { model, endpoint: 'https://' + host, kind: 'video' }).entry;
        assert.equal(entry.id, id);
        assert.equal(entry.options.resolutionTier.type, 'unsupported');
        assert.equal(validateModelParameterRequest(entry, { duration: 30, ratio: '16:9' }, { image: 10 }).ok, true);
        assert.equal(validateModelParameterRequest(entry, { duration: 31, ratio: '16:9' }, { image: 10 }).ok, false);
        assert.equal(validateModelParameterRequest(entry, { duration: 30, ratio: '16:9' }, { image: 11 }).ok, false);
    }
    assert.throws(() => addCatalogModel(config), /already exists/);
    assert.equal(/160\.202|supplier|sk-|costCny/.test(JSON.stringify(config.models.at(-1))), false);
});

test('catalog follows the current peer group after an administrator reorganizes groups', () => {
    const current = { models: [{ id: 'ravenhash-video.ft25-image30', presentation: { routeGroup: 'zhubo-video', routeOrder: 12 } }],
        catalogGroups: [{ id: 'zhubo-video', kind: 'video', label: 'Seedance 2.5 recommended', order: 20, scope: 'catalog' }] };
    const next = addCatalogModel(current);
    assert.deepEqual(next.catalogGroups, current.catalogGroups);
    assert.deepEqual(next.models[0], current.models[0]);
    assert.equal(next.models.at(-1).presentation.routeGroup, 'zhubo-video');
    assert.equal(next.models.at(-1).presentation.routeOrder, 13);
});
