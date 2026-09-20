const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GlobalAiOpcAssets, buildGlobalAiOpcBody, globalAiOpcEndpoint, MODEL } = require('./globalaiopc-video.cjs');
const { buildVideoGenerationEndpoint } = require('./video-provider-adapters');

const endpoint = 'https://supplier.test/kyyReactApiServer/v2/model-center/tasks';
const image = 'https://media.test/one.png';
const json = data => new Response(JSON.stringify(data));

test('GlobalAiOpc uses its native endpoint and documented parameter types, ratios and reference limits', () => {
    for (const suffix of ['', '/', '/kyyReactApiServer', '/kyyReactApiServer/v2', '/kyyReactApiServer/v2/model-center/tasks/']) {
        assert.equal(buildVideoGenerationEndpoint(`https://supplier.test${suffix}`, MODEL), endpoint);
    }
    assert.throws(() => globalAiOpcEndpoint('https://supplier.test/v1'), /API 地址/);
    const body = buildGlobalAiOpcBody({ prompt: 'test', duration: 30, resolution: '1080p', aspectRatio: 'adaptive', generateAudio: false,
        referenceImages: Array(30).fill(image), referenceVideos: Array(10).fill('https://media.test/a.mp4'), referenceAudios: Array(10).fill('https://media.test/a.mp3') });
    assert.equal(body.duration, 30); assert.equal(body.generate_audio, false); assert.equal(body.seed, -1);
    assert.equal(body.aspect_ratio, 'adaptive'); assert.equal(body.reference_images.length, 30);
    assert.equal('seconds' in body || 'ratio' in body || 'images' in body, false);
    assert.deepEqual(buildGlobalAiOpcBody({ prompt: 'test', referenceImages: [image, image] }), {
        model: MODEL, prompt: 'test', duration: 4, aspect_ratio: '16:9', resolution: '720p', seed: -1, generate_audio: true,
        first_image: image, last_image: image
    });
    for (const parameters of [{ duration: 31 }, { duration: 4.5 }, { resolution: '4k' }, { generateAudio: 'true' },
        { referenceImages: Array(31).fill(image) }, { referenceVideos: Array(11).fill(image) }, { referenceAudios: Array(11).fill(image) },
        { referenceImages: ['data:image/png;base64,abc'] }]) assert.throws(() => buildGlobalAiOpcBody({ prompt: 'test', ...parameters }));
});

function setup(t, fetch, maxPolls = 2) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'globalaiopc-assets-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const options = { directory, fetch, wait: async () => {}, maxPolls };
    return { options, assets: new GlobalAiOpcAssets(options), input: { endpoint, apiKey: 'fixture-secret', url: image, assetType: 'Image' } };
}

test('asset audit is awaited and cached IDs survive restart without caching credentials or private URLs', async t => {
    const calls = [];
    const h = setup(t, async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
        assert.equal(options.redirect, 'error');
        return json({ assetId: 'asset-1', status: url.endsWith('assetUpload') ? 'PROCESSING' : 'ACTIVE' });
    });
    assert.equal(await h.assets.resolve(h.input), 'assetId://asset-1');
    assert.deepEqual(calls[0].body, { assetType: 'Image', url: image, model: 'sd_2.5' });
    assert.equal(calls.length, 2);
    const reloaded = new GlobalAiOpcAssets(h.options);
    assert.equal(await reloaded.resolve(h.input), 'assetId://asset-1');
    assert.equal(calls.filter(call => call.url.endsWith('assetUpload')).length, 1);
    assert.doesNotMatch(fs.readFileSync(h.assets.file, 'utf8'), /fixture-secret|media.test/);
});

test('asset failures, unknown states and cancellation stop before a video submission', async t => {
    let status = 'FAILED'; let requests = 0;
    const h = setup(t, async () => { requests++; return json({ assetId: 'asset-1', status, errorMessage: 'fixture-secret rejected' }); });
    await assert.rejects(h.assets.resolve(h.input), error => /审核未通过/.test(error.message) && !error.message.includes('fixture-secret'));
    status = 'NEW_UNKNOWN';
    await assert.rejects(h.assets.resolve(h.input), /未知素材状态/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.assets.resolve({ ...h.input, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(requests, 2);
});

test('pending audits retain IDs for later retries and different account keys never share cached assets', async t => {
    let status = 'PROCESSING', uploads = 0;
    const h = setup(t, async url => {
        if (url.endsWith('assetUpload')) uploads++;
        return json({ assetId: `asset-${uploads}`, status });
    }, 0);
    await assert.rejects(h.assets.resolve(h.input), /仍在审核/);
    status = 'ACTIVE';
    await h.assets.resolve(h.input);
    assert.equal(uploads, 1);
    await h.assets.resolve({ ...h.input, apiKey: 'another-key' });
    assert.equal(uploads, 2);
});
