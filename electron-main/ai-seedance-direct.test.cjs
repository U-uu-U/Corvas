const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVideoGenerationEndpoint } = require('./video-provider-adapters.js');

test('ai station numeric Seedance uses the New API video protocol', () => {
    for (const suffix of ['', '/v1', '/v1/videos', '/v1/video/generations']) {
        assert.equal(buildVideoGenerationEndpoint('https://ai.ravenhash.org' + suffix, 'b_seedance_v2.0'),
            'https://ai.ravenhash.org/v1/videos');
    }
});

test('the new endpoint binding does not change other hosts or models', () => {
    for (const host of ['art.ravenhash.org', 'cart.ravenhash.org', 'ai.ravenhash.org.example.com']) {
        assert.equal(buildVideoGenerationEndpoint(`https://${host}/v1`, 'b_seedance_v2.0'),
            `https://${host}/v1/video/generations`);
    }
    assert.equal(buildVideoGenerationEndpoint('https://ai.ravenhash.org/v1', 'other-video'),
        'https://ai.ravenhash.org/v1/video/generations');
});
