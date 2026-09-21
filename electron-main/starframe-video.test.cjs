const test = require('node:test');
const assert = require('node:assert/strict');
const { STARFRAME_MODEL, buildStarFrameBody, starFrameClientId, starFrameContentUrl, starFrameDownloadRequest } = require('./starframe-video.cjs');
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
    for (const url of ['https://starframe-sh.tos-s3-cn-shanghai.volces.com/videos/result.mp4?X-Amz-Signature=fixture',
        'https://elsewhere.test/v1/videos/task_1/content', '/v1/videos/task_2/content', '/v1/models', 'malformed-url']) {
        assert.equal(starFrameContentUrl(endpoint, 'task_1', { ...response, metadata: { url } }), `${endpoint}/task_1/content`);
    }
    assert.throws(() => starFrameContentUrl(endpoint, 'task_1', { ...response, id: 'task_2' }), /原任务 ID/);
    assert.throws(() => starFrameContentUrl(endpoint, '../tasks', response), /有效任务 ID/);
    assert.equal(getVideoPayloadError({ status: 'failed', metadata: { fail_reason: 'reference rejected' } }),
        '任务未能完成，请根据排查编号联系管理员。');
});

test('verified signed storage URLs download without a key while other metadata uses the original API task', () => {
    const endpoint = 'https://api.xzapi.vip/v1/videos';
    const signed = 'https://starframe-sh.tos-s3-cn-shanghai.volces.com/videos/result.mp4?X-Amz-Signature=fixture';
    assert.deepEqual(starFrameDownloadRequest(endpoint, 'task_1', { id: 'task_1', status: 'completed', metadata: { url: signed } }),
        { url: signed, requiresAuth: false });
    for (const url of ['/v1/videos/task_1/content', 'https://untrusted.test/result.mp4',
        'https://starframe-sh.tos-s3-cn-shanghai.volces.com.untrusted.test/result.mp4?X-Amz-Signature=fixture']) {
        assert.deepEqual(starFrameDownloadRequest(endpoint, 'task_1', { status: 'completed', metadata: { url } }),
            { url: `${endpoint}/task_1/content`, requiresAuth: true });
    }
});

test('owned relays use the video generation route and preserve signed URLs in normalized results', () => {
    const signed = 'https://starframe-sh.tos-s3-cn-shanghai.volces.com/videos/result.mp4?X-Amz-Signature=fixture';
    for (const host of ['art.ravenhash.org', 'cart.ravenhash.org']) {
        const endpoint = `https://${host}/v1/video/generations`;
        for (const path of ['', '/v1', '/v1/videos', '/v1/video/generations']) {
            assert.equal(buildVideoGenerationEndpoint(`https://${host}${path}`, STARFRAME_MODEL), endpoint);
        }
        assert.deepEqual(starFrameDownloadRequest(endpoint, 'task-1', { id: 'task-1', status: 'completed', data: [{ url: signed }] }),
            { url: signed, requiresAuth: false });
    }
    const direct = 'https://api.xzapi.vip/v1/videos';
    assert.deepEqual(starFrameDownloadRequest(direct, 'task-1', { status: 'completed', data: [{ url: signed }] }),
        { url: direct + '/task-1/content', requiresAuth: true });
});
