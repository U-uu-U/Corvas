import test from 'node:test';
import assert from 'node:assert/strict';
import { assertVideoGenerationAvailable, isVideoGenerationAvailable } from './video-generation-availability.mjs';

test('scoped remote availability blocks only managed accounts and keeps legacy pause rules elsewhere', () => {
    const config = { catalogMode: 'remote', catalogScope: { hosts: ['art.ravenhash.org'], kinds: ['video'] }, models: [] };
    assert.equal(isVideoGenerationAvailable({ model: 'sd2.5', capability: 'video', endpoint: 'https://art.ravenhash.org/v1' }, config), false);
    assert.equal(isVideoGenerationAvailable({ model: 'sd2.5', capability: 'video', endpoint: 'https://custom.test/v1' }, config), true);
    assert.equal(isVideoGenerationAvailable({ model: 'gpt-image-2', capability: 'image', endpoint: 'https://art.ravenhash.org/v1' }, config), true);
    assert.equal(isVideoGenerationAvailable({ model: 'seedance_v2.5-101010', endpoint: 'https://cart.ravenhash.org/v1' }, config), false);
});

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

test('StarFrame is restored while GlobalAiOpc remains paused', () => {
    for (const endpoint of ['https://api.xzapi.vip', 'https://api.xzapi.vip/v1', 'https://API.XZAPI.VIP/v1/videos']) {
        const provider = { model: 'ch0107-sd-2.5-720p', endpoint };
        assert.equal(isVideoGenerationAvailable(provider), true);
        assert.doesNotThrow(() => assertVideoGenerationAvailable(provider));
    }
    const paused = { model: 'sd_2.5_discount_v1', endpoint: 'https://zcbservice.aizfw.cn/kyyReactApiServer' };
    assert.equal(isVideoGenerationAvailable(paused), false);
    assert.throws(() => assertVideoGenerationAvailable(paused), { code: 'VIDEO_MODEL_PAUSED' });
});
