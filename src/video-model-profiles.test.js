import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL_CONFIG } from './model-config-default.js';
import { resolveModelConfigEntry, toVideoProfileOverrides } from './model-config-capabilities.js';
import { canUseTextProvider, inferProviderCapability } from './provider-capabilities.js';
import { DEFAULT_VIDEO_MODEL_PROFILE, getVideoModelProfile, describeVideoModelProfile } from '../shared/video-model-profiles.mjs';

test('StarFrame keeps the configured per-second sale on its exact host with or without a remote catalog', () => {
    const provider = { model: 'ch0107-sd-2.5-720p', endpoint: 'https://api.xzapi.vip/v1', name: 'StarFrame API' };
    const fallback = getVideoModelProfile(provider);
    const { entry } = resolveModelConfigEntry(DEFAULT_MODEL_CONFIG, provider);
    const configured = toVideoProfileOverrides(DEFAULT_MODEL_CONFIG, entry, provider);
    for (const profile of [fallback, configured]) {
        assert.equal(profile.price.amount, 1.06);
        assert.equal(profile.price.unit, 'second');
        assert.equal(profile.price.currency, 'CNY');
        assert.deepEqual(profile.referenceLimits, { image: 30, video: 10, audio: 10 });
        assert.deepEqual(profile.resolutions, ['720p']);
        assert.equal(profile.durations[0], 4);
        assert.equal(profile.durations.at(-1), 30);
    }
    const foreign = { ...provider, endpoint: 'https://api.xzapi.vip.example/v1' };
    assert.equal(getVideoModelProfile(foreign).price, undefined);
    assert.equal(toVideoProfileOverrides(DEFAULT_MODEL_CONFIG, entry, foreign).price, undefined);
    assert.equal(inferProviderCapability({ model: provider.model }), 'video');
    assert.equal(canUseTextProvider({ model: provider.model }), false);
});

test('GlobalAiOpc retains native controls with built-in config and an older remote catalog', () => {
    const provider = { model: 'sd_2.5_discount_v1', endpoint: 'https://zcbservice.aizfw.cn/kyyReactApiServer', name: 'GlobalAiOpc' };
    const fallback = getVideoModelProfile(provider);
    assert.deepEqual(fallback.referenceLimits, { image: 30, video: 10, audio: 10 });
    assert.deepEqual(fallback.resolutions, ['480p', '720p', '1080p']);
    assert.equal(fallback.defaultDuration, 4);
    assert.equal(fallback.supportsGeneratedAudio, true);
    assert.equal(fallback.ratios.includes('21:9'), true);
    assert.equal(fallback.routeLabel, 'GlobalAiOpc');
    assert.equal(getVideoModelProfile({ ...provider, endpoint: 'https://art.ravenhash.org/v1' }).price, undefined);
    const { entry } = resolveModelConfigEntry(DEFAULT_MODEL_CONFIG, provider);
    const resolved = toVideoProfileOverrides(DEFAULT_MODEL_CONFIG, entry, provider);
    assert.equal(resolved.resolveAdaptiveRatio, false);
    assert.equal(resolved.defaultRatio, '16:9');
    assert.deepEqual(resolved.referenceLimits, fallback.referenceLimits);
    assert.equal(inferProviderCapability({ model: provider.model }), 'video');
    assert.equal(canUseTextProvider({ model: provider.model }), false);
});

test('HM profile advertises confirmed CNY sale, not upstream cost', () => {
    const profile = getVideoModelProfile({ model: 'seedance_v2.5', endpoint: 'https://art.ravenhash.org/v1' });
    assert.equal(profile.price.amount, 5);
    assert.equal(profile.price.currency, 'CNY');
    assert.equal(profile.referenceLimits.image, 10);
    assert.equal(profile.defaultDuration, 30);
    assert.deepEqual(profile.resolutions, ['720p']);
});

for (const [model, seconds, image, video, audio, price] of [
    ['seedance_v2.0-933', 15, 9, 3, 3, 6.5],
    ['seedance_v2.5-101010', 30, 10, 10, 10, 7],
    ['seedance_v2.5-301010', 30, 30, 10, 10, 10]
]) {
    test(`${model} keeps UI, CONFIG and CNY sale in agreement`, () => {
        const provider = { model, endpoint: 'https://art.ravenhash.org/v1' };
        const profile = getVideoModelProfile(provider);
        const { entry, ambiguous } = resolveModelConfigEntry(DEFAULT_MODEL_CONFIG, { ...provider, kind: 'video' });
        assert.equal(ambiguous, false);
        const configured = toVideoProfileOverrides(DEFAULT_MODEL_CONFIG, entry);
        assert.deepEqual(profile.referenceLimits, { image, video, audio });
        assert.deepEqual(profile.referenceLimits, configured.referenceLimits);
        assert.deepEqual(profile.durations, configured.durations);
        assert.equal(profile.durations[0], 4);
        assert.equal(profile.defaultDuration, seconds);
        assert.deepEqual(profile.resolutions, ['720p']);
        assert.equal(profile.price.amount, price);
        assert.equal(profile.price.currency, 'CNY');
        assert.equal(inferProviderCapability(provider), 'video');
        assert.match(describeVideoModelProfile(profile), new RegExp(`¥${price}/次`));
        for (const endpoint of ['https://video.zhubo.asia/v1', 'https://other.test', 'https://art.ravenhash.org.example/v1']) {
            assert.equal(getVideoModelProfile({ ...provider, endpoint }).price, undefined);
        }
    });
}

test('sd2.5 sale is restricted to the exact RavenHash art host', () => {
    const provider = { model: 'sd2.5', endpoint: 'https://art.ravenhash.org/v1' };
    assert.deepEqual(getVideoModelProfile(provider).price, {
        amount: 6, currency: 'CNY', unit: 'request', kind: 'sale', source: 'ravenhash configured sale', updatedAt: '2026-09-06T12:38:30Z'
    });
    for (const endpoint of ['https://ai.ravenhash.org/v1', 'https://art.ravenhash.org.example/v1', 'https://other.test', 'invalid']) {
        assert.equal(getVideoModelProfile({ ...provider, endpoint }).price, undefined);
    }
    assert.equal(getVideoModelProfile({ ...provider, model: 'sd2.5-haidiyue-face' }).price.amount, 6);
});

test('profile lookup retains matching, defaults and capability constraints', () => {
    assert.equal(getVideoModelProfile({ model: 'unknown' }), DEFAULT_VIDEO_MODEL_PROFILE);
    assert.equal(getVideoModelProfile({}), null);
    assert.equal(getVideoModelProfile({ model: 'doubao-seedance-2-0' }).supportsWebSearch, true);
    assert.equal(getVideoModelProfile({ model: 'minimax-h3' }).referenceLimits.audio, 3);
});

test('fixed-duration routes retain the same CNY sale and media capabilities', () => {
    for (const [model, label] of [['sd2.5-route1', '线路一'], ['sd2.5', '线路二']]) {
        const provider = { model, endpoint: 'https://art.ravenhash.org/v1' };
        const profile = getVideoModelProfile(provider);
        assert.equal(inferProviderCapability(provider), 'video');
        assert.equal(profile.routeLabel, label);
        assert.equal(profile.routeGroup, 'seedance25-fixed');
        assert.deepEqual(profile.durations, [30]);
        assert.deepEqual(profile.resolutions, ['720p']);
        assert.equal(profile.referenceLimits.image, 9);
        assert.equal(profile.price.amount, 6);
        assert.equal(profile.price.currency, 'CNY');
    }
});

test('unconnected model families have no bundled capability presets', () => {
    for (const model of ['seedance-1.5', 'wan-t2v', 'kling-v2', 'vidu']) {
        assert.equal(getVideoModelProfile({ model }), DEFAULT_VIDEO_MODEL_PROFILE);
    }
});
