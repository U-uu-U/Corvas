import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL_CONFIG } from './model-config-default.js';
import { mergeVideoProfile, resolveModelConfigEntry, toVideoProfileOverrides } from './model-config-capabilities.js';
import { canUseTextProvider, inferProviderCapability } from './provider-capabilities.js';
import { DEFAULT_VIDEO_MODEL_PROFILE, getVideoModelProfile, describeVideoModelProfile, getVideoModelGroup } from '../shared/video-model-profiles.mjs';

test('Zhubo Pro has its own wire limits and joins only the matching supplier group', () => {
    const provider = { model: 'seedance-2.5-pro', endpoint: 'https://art.ravenhash.org/v1' };
    const profile = getVideoModelProfile(provider);
    const { entry } = resolveModelConfigEntry(DEFAULT_MODEL_CONFIG, provider);
    const configured = toVideoProfileOverrides(DEFAULT_MODEL_CONFIG, entry, provider);
    assert.deepEqual(profile.resolutions, ['480p', '720p']);
    assert.deepEqual(profile.referenceLimits, { image: 30, video: 10, audio: 10 });
    assert.deepEqual(configured.referenceLimits, profile.referenceLimits);
    assert.deepEqual(configured.durations, profile.durations);
    assert.equal(profile.price.amount, 1.06);
    assert.equal(profile.price.unit, 'second');
    assert.equal(getVideoModelGroup(provider).routeGroup, 'zhubo-video');
    for (const model of ['seedance_v2.5', 'seedance_v2.0-933', 'seedance_v2.5-101010', 'seedance_v2.5-301010', 'sd2.5']) {
        assert.equal(getVideoModelGroup({ ...provider, model }).routeGroup, 'zhubo-video');
    }
    assert.equal(getVideoModelGroup({ ...provider, model: 'sd2.5-route1' }).routeGroup, 'seedance25-backup');
    assert.deepEqual(getVideoModelGroup({ ...provider, endpoint: 'https://another.test' }), {});
    assert.equal(getVideoModelProfile({ ...provider, endpoint: 'https://cart.ravenhash.org' }).price.amount, 1.25);
    assert.equal(getVideoModelProfile({ ...provider, endpoint: 'https://cart.ravenhash.org.example' }).price, undefined);
});

test('the new RavenHash site retains all nine enabled model presentations after catalog overrides', () => {
    const models = ['minimax-h3', 'sd2.5', 'seedance-2.5-pro', 'seedance_v2.5', 'seedance_v2.0-933',
        'sd2.5-route1', ...['fast', 'mini', 'pro'].map(variant => `artsdance2-0-${variant}-intl-260701`)];
    const profiles = host => models.map(model => {
        const provider = { model, endpoint: `https://${host}/v1` };
        const base = getVideoModelProfile(provider);
        const { entry } = resolveModelConfigEntry(DEFAULT_MODEL_CONFIG, { ...provider, kind: 'video' });
        return { ...mergeVideoProfile(base, toVideoProfileOverrides(DEFAULT_MODEL_CONFIG, entry, provider)),
            ...getVideoModelGroup(provider) };
    });
    const current = profiles('cart.ravenhash.org');
    const withoutPrice = entries => entries.map(({ price: _price, ...profile }) => profile);
    assert.deepEqual(withoutPrice(current), withoutPrice(profiles('art.ravenhash.org')));
    assert.deepEqual(current.slice(1, 6).map(profile => profile.price.amount), [6.86, 1.25, 5.72, 7.43, 6.86]);
    assert.equal(current[0].routeGroup, undefined);
    assert.deepEqual(current.slice(1, 5).map(profile => profile.routeOrder), [0, 1, 2, 3]);
    assert.equal(current[1].routeLabel, 'SD2.5 固定 30 秒（电商效果优化）');
    assert.equal(current[2].routeLabel, 'Seedance 2.5 Pro（满血满参）');
    assert.equal(current[5].routeGroupLabel, 'Seedance 2.5 备用渠道');
    assert.equal(current[5].routeLabel, 'Seedance 2.5 固定 30 秒（过人脸）');
    assert.equal(current[5].routeGroupAlways, true);
    assert.deepEqual(current.slice(6).map(profile => profile.label),
        ['Seedance 2.0 Fast', 'Seedance 2.0 Mini', 'Seedance 2.0 Pro']);
    assert.ok(current.slice(6).every(profile => profile.routeGroupLabel === 'Seedance 2.0 推荐渠道'
        && profile.routeGroupOrder > current[5].routeGroupOrder));
    for (const model of models) {
        for (const host of ['cart.ravenhash.org.example', 'sub.cart.ravenhash.org', 'another.test']) {
            const provider = { model, endpoint: `https://${host}/v1` };
            assert.deepEqual(getVideoModelGroup(provider), {});
            assert.equal(getVideoModelProfile(provider).price, undefined);
        }
    }
});

test('StarFrame keeps host-specific per-second sales with or without a remote catalog', () => {
    const provider = { model: 'ch0107-sd-2.5-720p', endpoint: 'https://api.xzapi.vip/v1', name: 'StarFrame API' };
    const { entry } = resolveModelConfigEntry(DEFAULT_MODEL_CONFIG, provider);
    for (const [host, amount] of [['api.xzapi.vip', 1.06], ['art.ravenhash.org', 1.06], ['cart.ravenhash.org', 1.25]]) {
        const hosted = { ...provider, endpoint: `https://${host}/v1` };
        const fallback = getVideoModelProfile(hosted);
        const configured = mergeVideoProfile(fallback, toVideoProfileOverrides(DEFAULT_MODEL_CONFIG, entry, hosted));
        for (const profile of [fallback, configured]) {
            assert.equal(profile.price.amount, amount);
            assert.equal(profile.price.unit, 'second');
            assert.equal(profile.price.currency, 'CNY');
            assert.deepEqual(profile.referenceLimits, { image: 30, video: 10, audio: 10 });
            assert.deepEqual(profile.resolutions, ['720p']);
            assert.equal(profile.durations[0], 4);
            assert.equal(profile.durations.at(-1), 30);
            assert.doesNotMatch(describeVideoModelProfile(profile, { includePrice: false }), /[¥$]|元|费用/);
        }
    }
    for (const host of ['api.xzapi.vip.example', 'sub.api.xzapi.vip', 'art.ravenhash.org.example', 'cart.ravenhash.org.example', 'sub.cart.ravenhash.org', 'another.test']) {
        const foreign = { ...provider, endpoint: `https://${host}/v1` };
        assert.equal(getVideoModelProfile(foreign).price, undefined);
        assert.equal(toVideoProfileOverrides(DEFAULT_MODEL_CONFIG, entry, foreign).price, undefined);
    }
    assert.equal(inferProviderCapability({ model: provider.model }), 'video');
    assert.equal(canUseTextProvider({ model: provider.model }), false);
});

test('StarFrame joins the shared Seedance 2.5 backup group only on supported exact hosts and model', () => {
    const provider = { model: 'ch0107-sd-2.5-720p', endpoint: 'https://api.xzapi.vip/v1' };
    const group = getVideoModelGroup(provider);
    assert.equal(group.routeGroup, 'seedance25-backup');
    assert.equal(group.routeGroupLabel, 'Seedance 2.5 备用渠道');
    assert.equal(group.label, '2.5pro 备用（满参）');
    assert.equal(group.routeLabel, '2.5pro 备用（满参）');
    assert.equal(group.routeModelLabel, provider.model);
    assert.equal(group.routeGroupScope, 'catalog');
    assert.equal(group.routeGroupAlways, true);
    for (const host of ['art.ravenhash.org', 'cart.ravenhash.org']) {
        const hosted = { ...provider, endpoint: `https://${host}/v1` };
        assert.deepEqual(getVideoModelGroup(hosted), group);
        const { entry } = resolveModelConfigEntry(DEFAULT_MODEL_CONFIG, hosted);
        const profile = { ...mergeVideoProfile(getVideoModelProfile(hosted),
            toVideoProfileOverrides(DEFAULT_MODEL_CONFIG, entry, hosted)), ...getVideoModelGroup(hosted) };
        assert.equal(profile.label, group.label);
        assert.equal(profile.routeLabel, group.routeLabel);
        const backup = getVideoModelGroup({ model: 'sd2.5-route1', endpoint: `https://${host}/v1` });
        assert.equal(backup.routeGroup, group.routeGroup);
        assert.equal(backup.routeGroupScope, group.routeGroupScope);
    }
    for (const host of ['api.xzapi.vip.example', 'sub.api.xzapi.vip', 'art.ravenhash.org.example', 'cart.ravenhash.org.example', 'sub.cart.ravenhash.org', 'another.test']) {
        assert.deepEqual(getVideoModelGroup({ ...provider, endpoint: `https://${host}/v1` }), {});
    }
    assert.deepEqual(getVideoModelGroup({ ...provider, model: `${provider.model}-custom` }), {});
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
    assert.equal(getVideoModelProfile({ model: 'seedance_v2.5', endpoint: 'https://cart.ravenhash.org/v1' }).price.amount, 5.72);
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
        const cart = getVideoModelProfile({ ...provider, endpoint: 'https://cart.ravenhash.org/v1' });
        assert.equal(cart.price.amount, ({ 'seedance_v2.0-933': 7.43, 'seedance_v2.5-101010': 8, 'seedance_v2.5-301010': 11.43 })[model]);
        assert.equal(inferProviderCapability(provider), 'video');
        assert.match(describeVideoModelProfile(profile), new RegExp(`¥${price}/次`));
        for (const endpoint of ['https://video.zhubo.asia/v1', 'https://other.test', 'https://art.ravenhash.org.example/v1', 'https://cart.ravenhash.org.example/v1']) {
            assert.equal(getVideoModelProfile({ ...provider, endpoint }).price, undefined);
        }
    });
}

test('sd2.5 sale is restricted to the exact RavenHash art and cart hosts', () => {
    const provider = { model: 'sd2.5', endpoint: 'https://art.ravenhash.org/v1' };
    assert.deepEqual(getVideoModelProfile(provider).price, {
        amount: 6, currency: 'CNY', unit: 'request', kind: 'sale', source: 'ravenhash configured sale', updatedAt: '2026-09-06T12:38:30Z'
    });
    assert.equal(getVideoModelProfile({ ...provider, endpoint: 'https://cart.ravenhash.org/v1' }).price.amount, 6.86);
    for (const endpoint of ['https://ai.ravenhash.org/v1', 'https://art.ravenhash.org.example/v1', 'https://cart.ravenhash.org.example/v1', 'https://other.test', 'invalid']) {
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
