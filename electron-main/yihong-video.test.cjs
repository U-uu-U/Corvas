const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeedance25RequestBody, buildVideoGenerationEndpoint, isYihongSuperModel,
    seedanceReferenceLimits } = require('./video-provider-adapters');

const model = 'seedance-2.5-super';
const refs = (count, ext) => Array.from({ length: count }, (_, i) => `https://example.test/${i}.${ext}`);

test('Yihong Super preserves the wire name and complete reference contract on both relays', () => {
    for (const host of ['art.ravenhash.org', 'cart.ravenhash.org', 'yihongapi.com']) {
        const model = host === 'yihongapi.com' ? 'seedance2.5 super' : 'seedance-2.5-super';
        const endpoint = `https://${host}/v1`;
        const input = { endpoint, model, prompt: 'fixture', duration: 30, aspectRatio: '21:9', resolution: '720p',
            referenceImages: refs(30, 'png'), referenceVideos: refs(10, 'mp4'), referenceAudios: refs(10, 'mp3') };
        assert.equal(isYihongSuperModel(model, endpoint), true);
        assert.equal(isYihongSuperModel('seedance2.5 super', endpoint), true);
        assert.deepEqual(seedanceReferenceLimits(model, endpoint), { image: 30, video: 10, audio: 10 });
        assert.deepEqual(buildSeedance25RequestBody(input), { model, prompt: 'fixture', seconds: 30,
            ratio: '21:9', resolution: '720p', image_urls: input.referenceImages,
            video_urls: input.referenceVideos, audio_urls: input.referenceAudios });
        assert.equal(buildSeedance25RequestBody({ ...input, duration: undefined }).seconds, 5);
        assert.equal(buildSeedance25RequestBody({ ...input, duration: 5 }).seconds, 5);
        assert.equal(buildVideoGenerationEndpoint(endpoint, model),
            `https://${host}/v1/${host === 'yihongapi.com' ? 'videos' : 'video/generations'}`);
        for (const duration of [4, 31, 5.5]) assert.throws(() => buildSeedance25RequestBody({ ...input, duration }));
        for (const field of ['referenceImages', 'referenceVideos', 'referenceAudios']) {
            assert.throws(() => buildSeedance25RequestBody({ ...input, [field]: [...input[field], input[field][0]] }));
        }
        assert.throws(() => buildSeedance25RequestBody({ ...input, resolution: '1080p' }));
        assert.throws(() => buildSeedance25RequestBody({ ...input, aspectRatio: '2:1' }));
        for (const url of ['data:image/png;base64,YQ==', 'http://example.test/ref.png']) {
            assert.throws(() => buildSeedance25RequestBody({ ...input, referenceImages: [url] }));
        }
    }
});

test('Yihong capabilities do not change other Seedance routes', () => {
    for (const endpoint of ['https://example.test/v1', '']) {
        assert.equal(isYihongSuperModel(model, endpoint), false);
        assert.deepEqual(seedanceReferenceLimits(model, endpoint), { image: 10, video: 0, audio: 0 });
    }
    assert.deepEqual(seedanceReferenceLimits('seedance_v2.5', 'https://art.ravenhash.org/v1'),
        { image: 10, video: 0, audio: 0 });
});
