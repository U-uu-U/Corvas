const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeedance25RequestBody, buildVideoGenerationEndpoint, getHmSeedance20Spec,
    isSeedanceVideoModel, seedanceReferenceLimits } = require('./video-provider-adapters');

const refs = (count, extension) => Array.from({ length: count }, (_, index) => `https://example.test/${index}.${extension}`);
for (const [model, resolutions, counts] of [
    ['SD2.0FAST813', ['720p', '1080p', '2k'], [8, 1, 3]],
    ['SD2.0MINI503', ['720p'], [5, 0, 3]]
]) {
    test(`${model} preserves resolution and exact reference limits on both relay routes`, () => {
        for (const host of ['art.ravenhash.org', 'cart.ravenhash.org', 'video.zhubo.asia']) {
            const endpoint = `https://${host}/v1`;
            const [image, video, audio] = counts;
            const input = { model, endpoint, prompt: 'fixture', duration: 15, aspectRatio: '9:16',
                referenceImages: refs(image, 'png'), referenceVideos: refs(video, 'mp4'), referenceAudios: refs(audio, 'mp3') };
            assert.equal(isSeedanceVideoModel(model), true);
            assert.deepEqual(seedanceReferenceLimits(model, endpoint), { image, video, audio });
            for (const resolution of resolutions) {
                const body = buildSeedance25RequestBody({ ...input, resolution });
                assert.deepEqual(body, { model, prompt: 'fixture', seconds: 15, ratio: '9:16', resolution,
                    image_urls: input.referenceImages, ...(video ? { video_urls: input.referenceVideos } : {}),
                    audio_urls: input.referenceAudios });
            }
            assert.equal(buildSeedance25RequestBody({ ...input, duration: 4 }).seconds, 4);
            for (const duration of [3, 16, 4.5]) assert.throws(() => buildSeedance25RequestBody({ ...input, duration }));
            for (const field of ['referenceImages', 'referenceVideos', 'referenceAudios']) {
                assert.throws(() => buildSeedance25RequestBody({ ...input, [field]: [...input[field], 'https://example.test/extra'] }));
            }
            assert.throws(() => buildSeedance25RequestBody({ ...input, resolution: '4k' }));
            assert.throws(() => buildSeedance25RequestBody({ ...input, referenceImages: ['data:image/png;base64,YQ=='] }));
            assert.equal(buildVideoGenerationEndpoint(endpoint, model),
                `https://${host}/v1/${host === 'video.zhubo.asia' ? 'videos' : 'video/generations'}`);
        }
    });
}

test('new HM routes do not expand 933, Fast 803 or unknown hosts', () => {
    assert.equal(getHmSeedance20Spec('SD2.0FAST803', 'https://art.ravenhash.org'), null);
    assert.equal(getHmSeedance20Spec('SD2.0FAST813', 'https://example.test'), null);
    assert.deepEqual(seedanceReferenceLimits('seedance_v2.0-933', 'https://art.ravenhash.org'),
        { image: 9, video: 3, audio: 3 });
});
