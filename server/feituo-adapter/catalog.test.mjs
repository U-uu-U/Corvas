import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { models, saleCny, addCatalogModels } from './catalog.mjs';
import { createValidator } from '../../configserver/lib/validate.mjs';
import { resolveModelConfigEntry } from '../../src/model-config-capabilities.js';
import { existingSpec, newSpec, updateSeedance20Catalog } from './seedance20-catalog.mjs';

const require = createRequire(import.meta.url);
const { validateModelParameterRequest } = require('../../shared/model-parameter-rules.cjs');
const { isSeedanceVideoModel, buildVideoGenerationEndpoint } = require('../../electron-main/video-provider-adapters.js');
const seed = JSON.parse(fs.readFileSync(new URL('../../configserver/seed/model-config.default.json', import.meta.url), 'utf8'));

test('restores only the requested hidden 933 card and appends the long-term card to the current group', () => {
    const current = addCatalogModels(seed, models.filter(spec => spec !== newSpec));
    current.catalogGroups.push({ id: newSpec.group, kind: 'video', label: 'Seedance 2.0', order: 10, scope: 'catalog' });
    const original = current.models.find(entry => entry.id === existingSpec.id);
    original.presentation.visible = false;
    original.presentation.routeGroup = '';
    original.presentation.label = 'Custom 933 label';
    const peer = current.models.find(entry => entry.id === models[0].id);
    peer.catalog.enabled = false;
    const saved = structuredClone(current);
    const updated = updateSeedance20Catalog(current);
    assert.deepEqual(current, saved);
    assert.equal(updated.models.find(entry => entry.id === existingSpec.id).presentation.visible, true);
    assert.equal(updated.models.find(entry => entry.id === existingSpec.id).presentation.label, 'Custom 933 label');
    assert.equal(updated.models.find(entry => entry.id === existingSpec.id).presentation.routeGroup, newSpec.group);
    assert.deepEqual(updated.models.find(entry => entry.id === peer.id), peer);
    assert.equal(updated.models.length, current.models.length+1);
    assert.deepEqual(updated.models.at(-1).options.duration.values, [5, 10, 15]);
});

test('catalog additions preserve previous entries and pass the CONFIG schema', async () => {
    const config = addCatalogModels(seed);
    const validator = await createValidator({ schemaPath: fileURLToPath(new URL('../../configserver/schema/model-config.schema.json', import.meta.url)) });
    const checked = validator.validate(config);
    assert.equal(checked.ok, true, checked.errors.join('; '));
    assert.deepEqual(config.models.slice(0, -models.length), seed.models);
    assert.deepEqual(models.map(saleCny), [3.6, 7.5, 3.6, 7.5]);
    const added = JSON.stringify(config.models.slice(-models.length));
    assert.equal(/costCny|feituokuajing\.com|ftk_|supplier/.test(added), false);
    assert.throws(() => addCatalogModels(config), /already exists/);
});

test('both relay hosts resolve generic video routes with full CONFIG reference limits', () => {
    const config = addCatalogModels(seed);
    for (const spec of models) {
        for (const endpoint of ['https://art.ravenhash.org', 'https://cart.ravenhash.org']) {
            const { entry } = resolveModelConfigEntry(config, { model: spec.model, endpoint, kind: 'video' });
            assert.equal(entry.id, spec.id);
            assert.equal(isSeedanceVideoModel(spec.model), false);
            assert.match(buildVideoGenerationEndpoint(endpoint, spec.model), /\/v1\/video\/generations$/);
            const checked = validateModelParameterRequest(entry,
                { duration: spec.minSeconds, resolutionTier: '720p', ratio: '16:9' },
                { image: spec.images, video: spec.videos, audio: spec.audios });
            assert.equal(checked.ok, true);
            assert.equal(checked.entry.capabilities.referenceImages.max, spec.images);
            assert.equal(validateModelParameterRequest(entry,
                { duration: spec.maxSeconds + 1, resolutionTier: '720p', ratio: '16:9' }, {}).ok, false);
            if (spec.durations) {
                assert.equal(validateModelParameterRequest(entry,
                    { duration: 6, resolutionTier: '720p', ratio: '16:9' }, {}).ok, false);
            }
        }
    }
});
