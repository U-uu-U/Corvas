import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { addCatalogModel, spec } from './catalog.mjs';
import { createValidator } from '../../configserver/lib/validate.mjs';

const require = createRequire(import.meta.url);
const { isSeedanceVideoModel, buildVideoGenerationEndpoint } = require('../../electron-main/video-provider-adapters.js');

test('catalog selects the generic configurable route and validates the remote contract', async () => {
    const current = JSON.parse(fs.readFileSync(new URL('../../configserver/seed/model-config.default.json', import.meta.url), 'utf8'));
    current.catalogGroups ||= [];
    if (!current.catalogGroups.some(group => group.id === spec.group)) {
        current.catalogGroups.push({ id: spec.group, kind: 'video', label: 'Seedance 2.5 推荐渠道', order: 20, scope: 'catalog' });
    }
    const saved = structuredClone(current);
    const config = addCatalogModel(current);
    assert.deepEqual(current, saved);
    const validator = await createValidator({ schemaPath: new URL('../../configserver/schema/model-config.schema.json', import.meta.url) });
    const validation = validator.validate(config);
    assert.equal(validation.ok, true, validation.errors.join('; '));
    const entry = config.models.at(-1);
    assert.deepEqual([entry.capabilities.referenceImages.max, entry.capabilities.referenceVideos.max, entry.capabilities.referenceAudios.max], [30, 10, 10]);
    assert.equal(entry.presentation.routeGroup, spec.group);
    assert.equal(isSeedanceVideoModel(spec.model), false);
    assert.ok(!JSON.stringify(config).includes(spec.origin));
    assert.ok(!JSON.stringify(config).includes(spec.upstreamModel));
    for (const host of ['art.ravenhash.org', 'cart.ravenhash.org']) {
        const endpoint = buildVideoGenerationEndpoint('https://'+host+'/v1', spec.model);
        assert.equal(endpoint, 'https://'+host+'/v1/video/generations');
    }
    assert.throws(() => addCatalogModel(config), /already exists/);
});
