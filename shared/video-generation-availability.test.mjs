import test from 'node:test';
import assert from 'node:assert/strict';
import { assertVideoGenerationAvailable, isVideoGenerationAvailable } from './video-generation-availability.mjs';

test('both RavenHash sites pause only the two retired HM variants', () => {
    for (const host of ['art.ravenhash.org', 'cart.ravenhash.org']) {
        for (const model of ['seedance_v2.5-101010', 'seedance_v2.5-301010']) {
            const provider = { model, endpoint: `https://${host}/v1` };
            assert.equal(isVideoGenerationAvailable(provider), false);
            assert.throws(() => assertVideoGenerationAvailable(provider), { code: 'VIDEO_MODEL_PAUSED' });
        }
        for (const model of ['minimax-h3', 'sd2.5', 'seedance-2.5-pro', 'seedance_v2.5', 'seedance_v2.0-933',
            'sd2.5-route1', ...['fast', 'mini', 'pro'].map(variant => `artsdance2-0-${variant}-intl-260701`)]) {
            assert.equal(isVideoGenerationAvailable({ model, endpoint: `https://${host}/v1` }), true);
        }
    }
});

test('pause rules do not extend to another host or a similarly named model', () => {
    for (const host of ['cart.ravenhash.org.example', 'sub.cart.ravenhash.org', 'another.test']) {
        assert.equal(isVideoGenerationAvailable({ model: 'seedance_v2.5-101010', endpoint: `https://${host}/v1` }), true);
    }
    assert.equal(isVideoGenerationAvailable({ model: 'seedance_v2.5-101010-custom', endpoint: 'https://cart.ravenhash.org/v1' }), true);
    assert.equal(isVideoGenerationAvailable({ model: ' SEEDANCE_V2.5-101010 ', endpoint: 'https://CART.RAVENHASH.ORG/v1' }), false);
});
