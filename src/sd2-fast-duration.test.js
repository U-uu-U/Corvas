import test from 'node:test';
import assert from 'node:assert/strict';
import { constrainVideoProfileDuration, getVideoDurationConstraint } from '../shared/video-model-profiles.mjs';
import { resolveVideoModelProfile, validateModelRequest } from './model-config-capabilities.js';
import { AgentSidebar } from './agent-sidebar.js';

const provider = { model: 'sd2-fast', endpoint: 'https://art.ravenhash.org/v1', kind: 'video' };
const config = { schemaVersion: 1, catalogMode: 'remote', models: [{
    id: 'sd2-fast', kind: 'video', match: { model: ['^sd2-fast$'] },
    catalog: { model: 'sd2-fast', hosts: ['art.ravenhash.org', 'cart.ravenhash.org', 'yueqi.icu'], enabled: true },
    options: { duration: { type: 'range', min: 1, max: 15, default: 10, integer: true },
        resolutionTier: { type: 'enum', values: ['480p', '720p'], default: '480p' } }
}] };

test('SD2 Fast duration choices follow resolution without mutating the full CONFIG profile', () => {
    for (const host of ['art.ravenhash.org', 'cart.ravenhash.org', 'yueqi.icu']) {
        const account = { ...provider, endpoint: `https://${host}/v1` };
        const full = resolveVideoModelProfile(config, account);
        const sidebar = { _getBoundProvider: () => account, _getVideoProvider: () => account, _getVideoModelProfile: () => full };
        for (const [resolution, max] of [['720p', 12], ['480p', 15]]) {
            const profile = AgentSidebar.prototype.getVideoModelProfile.call(sidebar, { resolution });
            assert.equal(profile.durations.at(-1), max);
            assert.equal(profile.durations.length, max);
            assert.equal(profile.defaultDuration, 10);
        }
        assert.equal(full.durations.length, 15);
        const narrower = { ...full, durations: [4, 5], defaultDuration: 5 };
        assert.deepEqual(constrainVideoProfileDuration(narrower, account, '720p').durations, [4, 5]);
    }
    assert.equal(getVideoDurationConstraint({ ...provider, endpoint: 'https://art.ravenhash.org.example/v1' }, '720p'), null);
    assert.equal(getVideoDurationConstraint({ ...provider, model: 'another-fast' }, '720p'), null);
});

test('SD2 Fast request validation rejects invalid resolution-duration combinations before submission', () => {
    for (const [resolution, duration, allowed] of [['720p', 12, true], ['720p', 13, false],
        ['720p', 15, false], ['480p', 15, true], ['480p', 16, false], ['720p', 4.5, false]]) {
        const result = validateModelRequest({ config, provider, fields: { resolutionTier: resolution, duration } });
        assert.equal(result.ok, allowed, `${resolution} / ${duration}`);
        if (!allowed) assert.equal(result.errors[0].field, 'duration');
    }
});

test('remote conditional rules drive sidebar controls and validation, including larger future limits', () => {
    const remote = structuredClone(config);
    remote.models[0].parameterRules = { version: 1, rules: [
        { when: { resolutionTier: '720p' }, options: { duration: { type: 'range', min: 1, max: 20, integer: true } },
            capabilities: { referenceImages: { supported: true, max: 4 }, referenceAudios: { supported: false, max: 0 } } },
        { when: { resolutionTier: '480p' }, options: { duration: { type: 'enum', values: [5, 10, 15] } } }
    ] };
    const full = resolveVideoModelProfile(remote, provider);
    const sidebar = { _getBoundProvider: () => provider, _getVideoProvider: () => provider, _getVideoModelProfile: () => full };
    const hd = AgentSidebar.prototype.getVideoModelProfile.call(sidebar, { resolution: '720p' });
    assert.equal(hd.durations.at(-1), 20);
    assert.equal(hd.referenceLimits.image, 4);
    assert.equal(hd.referenceLimits.audio, 0);
    assert.deepEqual(AgentSidebar.prototype.getVideoModelProfile.call(sidebar, { resolution: '480p' }).durations, [5, 10, 15]);
    assert.equal(validateModelRequest({ config: remote, provider, fields: { resolutionTier: '720p', duration: 20 } }).ok, true);
    const invalid = validateModelRequest({ config: remote, provider, fields: { resolutionTier: '720p', duration: 21 } });
    assert.equal(invalid.errors[0].max, 20);
    assert.equal(invalid.errors[0].actual, 21);
    assert.equal(full.durations.at(-1), 15);
    remote.models[0].parameterRules.version = 2;
    assert.equal(validateModelRequest({ config: remote, provider, fields: { resolutionTier: '720p', duration: 10 } }).errors[0].code,
        'PARAMETER_RULES_UNSUPPORTED');
});
