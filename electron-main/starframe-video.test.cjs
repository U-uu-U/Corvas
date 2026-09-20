const test = require('node:test');
const assert = require('node:assert/strict');
const { STARFRAME_MODEL, buildStarFrameBody, starFrameClientId, starFrameContentUrl } = require('./starframe-video.cjs');
const { buildVideoGenerationEndpoint, getVideoPayloadError } = require('./video-provider-adapters');

test('StarFrame uses references mode with singular and plural fields instead of other Seedance wire formats', () => {
    const media = 'https://media.test/asset';
    const base = { clientTaskId: 'request-1', prompt: 'test', duration: 5 };
    const text = buildStarFrameBody(base);
    assert.deepEqual(text, { model: STARFRAME_MODEL, prompt: 'test', client_task_id: 'request-1', mode: 'references', duration: 5, resolution: '720p' });
    const mixed = buildStarFrameBody({ ...base, referenceImages: [media], referenceVideos: [media, media], referenceAudios: [media] });
    assert.deepEqual(mixed.references, { image: media, videos: [media, media], audio: media });
    assert.equal('frames' in mixed || 'image_urls' in mixed || 'seconds' in mixed, false);
    const maximum = buildStarFrameBody({ ...base, referenceImages: Array(30).fill(media), referenceVideos: Array(10).fill(media), referenceAudios: Array(10).fill(media) });
    assert.equal(maximum.references.images.length + maximum.references.videos.length + maximum.references.audios.length, 50);
    for (const invalid of [{ resolution: '1080p' }, { duration: 3 }, { duration: 31 }, { duration: 5.5 }, { clientTaskId: '' }, { aspectRatio: '0:0' },
        { referenceImages: [ 'data:image/png;base64,AAAA' ] }, { referenceImages: Array(31).fill(media) },
        { referenceVideos: Array(11).fill(media) }, { referenceAudios: Array(11).fill(media) }]) assert.throws(() => buildStarFrameBody({ ...base, ...invalid }));
});

test('client IDs remain stable and the native content URL cannot redirect API credentials to another task or host', () => {
    const endpoint = 'https://api.xzapi.vip/v1/videos';
    for (const base of ['https://api.xzapi.vip', 'https://api.xzapi.vip/v1', endpoint]) assert.equal(buildVideoGenerationEndpoint(base, STARFRAME_MODEL), endpoint);
    const id = starFrameClientId('任意本地任务:1');
    assert.equal(id, starFrameClientId('任意本地任务:1'));
    assert.match(id, /^[\w.-]{1,128}$/);
    const response = { status: 'completed', metadata: { url: '/v1/videos/task_1/content' } };
    assert.equal(starFrameContentUrl(endpoint, 'task_1', response), `${endpoint}/task_1/content`);
    assert.equal(starFrameContentUrl(endpoint, 'task_1', { ...response, status: 'in_progress' }), '');
    for (const url of ['https://elsewhere.test/v1/videos/task_1/content', '/v1/videos/task_2/content', '/v1/models']) {
        assert.throws(() => starFrameContentUrl(endpoint, 'task_1', { ...response, metadata: { url } }), /路径/);
    }
    assert.equal(getVideoPayloadError({ status: 'failed', metadata: { fail_reason: 'reference rejected' } }), 'reference rejected');
});
