import test from 'node:test';
import assert from 'node:assert/strict';
import { inferProviderCapability, canUseTextProvider } from './provider-capabilities.js';
import { imageGenerationRequestParams } from './generation-request-params.js';
import { toImageProfileOverrides, validateModelRequest } from './model-config-capabilities.js';
import { nanoBananaEntry, addNanoBanana } from '../server/nano-banana/catalog.mjs';

test('Nano Banana is an image model with native tier/ratio controls and no GPT-only options', () => {
    const model = nanoBananaEntry.catalog.model;
    assert.equal(inferProviderCapability({ model }), 'image');
    assert.equal(canUseTextProvider({ model }), false);
    const params = imageGenerationRequestParams({ resolutionTier: '4K', ratio: '1:4', stream: true, webSearch: true }, model);
    assert.equal(params.size, '4K');
    assert.equal(params.resolutionTier, '4K');
    assert.equal(params.ratio, '1:4');
    assert.equal(params.quality, undefined);
    assert.equal(params.webSearch, undefined);
    assert.equal(params.stream, false);
    const config = addNanoBanana({ catalogMode: 'remote', models: [] });
    const profile = toImageProfileOverrides(config, nanoBananaEntry);
    assert.deepEqual(profile.resolutionTiers, ['1K', '2K', '4K']);
    assert.ok(profile.ratios.includes('1:8'));
    assert.equal(profile.supportsWebSearch, false);
    const result = validateModelRequest({ config, provider: { endpoint: 'https://ai.ravenhash.org/v1', model, kind: 'image', modelCatalog: 'remote' },
        prompt: 'fixture', fields: { resolutionTier: params.size, ratio: params.ratio, n: 1 }, references: { image: { count: 2 } } });
    assert.equal(result.ok, true, JSON.stringify(result));
});
