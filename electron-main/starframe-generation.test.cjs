const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const sharp = require('sharp');
const { STARFRAME_MODEL } = require('./starframe-video.cjs');

let profile, fetchFixture, httpFixture, Bridge;
const originalLoad = Module._load;
try {
    Module._load = function (name, ...args) {
        if (name === 'https') return { get: (...params) => httpFixture(...params) };
        return name === 'electron' ? { app: { getPath: () => profile }, net: { fetch: (...args) => fetchFixture(...args) } }
            : originalLoad.call(this, name, ...args);
    };
    Bridge = require('./mcp-bridge');
} finally { Module._load = originalLoad; }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('StarFrame persists task IDs, queries native status and authenticates content download without resubmitting on recovery', async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-starframe-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const image = path.join(profile, 'ref.png');
    await sharp({ create: { width: 512, height: 512, channels: 3, background: '#cccccc' } }).png().toFile(image);
    for (const file of ['video-1.mp4', 'video-2.mp4', 'audio.mp3']) fs.writeFileSync(path.join(profile, file), file);
    const mediaUrl = file => `https://starframe.test/media/${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    const endpoint = 'https://starframe.test/v1/videos';
    const request = { clientTaskId: 'stable-1', prompt: 'fixture', duration: 5, ratio: '16:9', resolution: '720p',
        targetDir: profile, addToCanvas: false, sourceReferences: [{ filePath: image }],
        videoReferences: ['video-1.mp4', 'video-2.mp4'].map(file => ({ filePath: path.join(profile, file) })),
        audioReferences: [{ filePath: path.join(profile, 'audio.mp3') }],
        providerConfig: { endpoint, model: STARFRAME_MODEL, capability: 'video', apiKey: 'fixture-key',
            temporaryUploadEndpoint: 'https://starframe.test/storage', temporaryUploadToken: 'upload-fixture' } };
    let mode = 'success', posts = 0, downloads = 0, polls = 0;
    const submittedIds = [];
    fetchFixture = async (url, options = {}) => {
        assert.equal(new URL(url).hostname, 'starframe.test');
        if (url.endsWith('/storage')) {
            const form = await new Response(options.body, { headers: options.headers }).formData();
            const bytes = Buffer.from(await form.get('file').arrayBuffer());
            return json({ success: true, url: `https://starframe.test/media/${createHash('sha256').update(bytes).digest('hex')}` });
        }
        assert.equal(options.headers.Authorization, 'Bearer fixture-key');
        if (options.method === 'POST') {
            posts++; assert.equal(url, endpoint);
            const body = JSON.parse(options.body); submittedIds.push(body.client_task_id);
            assert.deepEqual(body, { model: STARFRAME_MODEL, client_task_id: 'stable-1', prompt: 'fixture', mode: 'references',
                aspect_ratio: '16:9', resolution: '720p', duration: 5, references: { image: mediaUrl(image),
                    videos: ['video-1.mp4', 'video-2.mp4'].map(file => mediaUrl(path.join(profile, file))), audio: mediaUrl(path.join(profile, 'audio.mp3')) } });
            if (mode === 'disconnected') throw new TypeError('fetch failed');
            if (mode === 'duplicate') return json({ error: { code: 'idempotent_task_active', message: 'duplicate' } }, 409);
            return json({ id: 'task-real-1', status: 'queued' });
        }
        if (url.endsWith('/content')) {
            downloads++; assert.equal(url, `${endpoint}/task-real-1/content`);
            return new Response('fixture video', { headers: { 'content-type': 'video/mp4' } });
        }
        polls++; assert.equal(url, `${endpoint}/task-real-1`);
        assert.equal(bridge.recoveryStore.get('stable-1').taskId, 'task-real-1');
        return json(mode === 'failed' ? { id: 'task-real-1', status: 'failed', metadata: { fail_reason: 'reference rejected' } }
            : { id: 'task-real-1', status: 'completed', metadata: { url: '/v1/videos/task-real-1/content' } });
    };
    const output = await bridge.generateVideoFromRenderer(request);
    assert.equal(output.taskId, 'task-real-1');
    assert.equal(fs.readFileSync(output.filePath, 'utf8'), 'fixture video');
    await bridge.resumeVideoFromRenderer({ ...request, taskId: 'task-real-1' });
    assert.deepEqual([posts, polls, downloads], [1, 2, 2]);
    mode = 'failed';
    await assert.rejects(bridge.resumeVideoFromRenderer({ ...request, taskId: 'task-real-1' }), /reference rejected/);
    for (const failure of ['disconnected', 'duplicate']) {
        mode = failure;
        await assert.rejects(bridge.generateVideoFromRenderer(request), error => error.submissionUnknown === true);
    }
    assert.deepEqual(submittedIds, ['stable-1', 'stable-1', 'stable-1']);
    assert.equal(polls, 3, 'No attempt to poll the client id as an upstream task');
});

test('authenticated content download strips API credentials from a CDN redirect during HTTP/1 fallback', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'starframe-download-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fetchFixture = async () => { throw new Error('ERR_HTTP2_PROTOCOL_ERROR'); };
    const hops = [];
    httpFixture = (url, options, callback) => {
        hops.push({ url: url.href, headers: options.headers });
        const request = new EventEmitter();
        request.setTimeout = () => {};
        request.destroy = error => request.emit('error', error);
        setImmediate(() => {
            const response = new PassThrough();
            response.statusCode = hops.length === 1 ? 302 : 200;
            response.headers = hops.length === 1 ? { location: 'https://cdn.test/signed-result.mp4' } : { 'content-type': 'video/mp4' };
            callback(response);
            response.end(response.statusCode === 200 ? 'fixture video' : '');
        });
        return request;
    };
    const output = await Bridge.downloadVideoWithAutoRefresh({ taskId: 'task-1', payload: { status: 'completed',
        metadata: { url: '/v1/videos/task-1/content' } } }, directory, 'fixture', {
        generationEndpoint: 'https://starframe.test/v1/videos', model: STARFRAME_MODEL, apiKey: 'fixture-key', taskId: 'task-1'
    });
    assert.equal(hops[0].headers.Authorization, 'Bearer fixture-key');
    assert.equal(hops[1].headers.Authorization, undefined);
    assert.equal(fs.readFileSync(output, 'utf8'), 'fixture video');
});
