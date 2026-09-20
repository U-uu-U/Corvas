const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const sharp = require('sharp');
const { MODEL } = require('./globalaiopc-video.cjs');

let profile, fetchFixture, Bridge;
const originalLoad = Module._load;
try {
    Module._load = function (name, ...args) {
        return name === 'electron' ? { app: { getPath: () => profile }, net: { fetch: (...args) => fetchFixture(...args) } }
            : originalLoad.call(this, name, ...args);
    };
    Bridge = require('./mcp-bridge');
} finally { Module._load = originalLoad; }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('native supplier runs upload, asset audit, submit, persisted task, poll, download and same-ID recovery', async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-globalaiopc-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const image = path.join(profile, 'reference.png');
    await sharp({ create: { width: 512, height: 512, channels: 3, background: '#cccccc' } }).png().toFile(image);
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    const endpoint = 'https://supplier.test/kyyReactApiServer/v2/model-center/tasks';
    const request = { clientTaskId: 'local-1', prompt: 'fixture', duration: 4, ratio: '21:9', resolution: '1080p', generateAudio: false,
        sourceReferences: [{ filePath: image }], targetDir: profile, addToCanvas: false,
        providerConfig: { endpoint, model: MODEL, capability: 'video', apiKey: 'fixture-key',
            temporaryUploadEndpoint: 'https://supplier.test/storage', temporaryUploadToken: 'storage-fixture' } };
    let posts = 0, uploads = 0, assetUploads = 0, polls = 0, mode = 'success';
    fetchFixture = async (url, options = {}) => {
        assert.equal(new URL(url).hostname, 'supplier.test', 'Never reach a real supplier from tests');
        if (url.endsWith('/storage')) { uploads++; return json({ success: true, url: 'https://supplier.test/reference.png' }); }
        if (url.endsWith('/assetUpload')) {
            assetUploads++;
            assert.deepEqual(JSON.parse(options.body), { assetType: 'Image', url: 'https://supplier.test/reference.png', model: 'sd_2.5' });
            return json({ assetId: 'asset-1', status: 'ACTIVE' });
        }
        if (url.endsWith('/assetDetail')) return json({ assetId: 'asset-1', status: mode === 'rejected' ? 'FAILED' : 'ACTIVE' });
        if (url.endsWith('/output.mp4')) return new Response('fixture video');
        assert.equal(options.headers.Authorization, 'Bearer fixture-key');
        if (options.method === 'POST') {
            posts++;
            assert.equal(url, endpoint);
            assert.equal(options.headers['X-Log-Id'], undefined);
            assert.deepEqual(JSON.parse(options.body), { model: MODEL, prompt: 'fixture', duration: 4, resolution: '1080p',
                aspect_ratio: '21:9', generate_audio: false, seed: -1, first_image: 'assetId://asset-1' });
            if (mode === 'disconnected') throw new TypeError('fetch failed');
            return json({ id: 'native-task-1', status: 'queued' });
        }
        polls++;
        assert.equal(url, `${endpoint}/native-task-1`);
        assert.equal(bridge.recoveryStore.get(request.clientTaskId).taskId, 'native-task-1');
        return json({ id: 'native-task-1', status: 'completed', result_url: 'https://supplier.test/output.mp4' });
    };
    const result = await bridge.generateVideoFromRenderer(request);
    assert.equal(result.taskId, 'native-task-1');
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'fixture video');
    assert.deepEqual([posts, uploads, assetUploads, polls], [1, 1, 1, 1]);
    await bridge.resumeVideoFromRenderer({ ...request, taskId: 'native-task-1' });
    assert.deepEqual([posts, assetUploads, polls], [1, 1, 2]);
    for (const invalid of [{ duration: 31 }, { sourceReferences: [{ filePath: path.join(profile, 'missing.png') }] }]) {
        await assert.rejects(bridge.generateVideoFromRenderer({ ...request, ...invalid }));
    }
    assert.equal(posts, 1);
    mode = 'rejected';
    await assert.rejects(bridge.generateVideoFromRenderer(request), /素材审核未通过/);
    assert.equal(posts, 1);
    mode = 'disconnected';
    await assert.rejects(bridge.generateVideoFromRenderer(request), error => error.submissionUnknown === true && /结果尚未确定/.test(error.message));
    assert.equal(posts, 2);
    assert.equal(polls, 2, 'A local log ID cannot be polled as an upstream task');
});
