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
        if (new URL(url).hostname === 'starframe-sh.tos-s3-cn-shanghai.volces.com') {
            downloads++;
            assert.equal(options.headers?.Authorization, undefined, 'Storage must not receive the API key');
            return new Response('fixture video', { headers: { 'content-type': 'video/mp4' } });
        }
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
            : { id: 'task-real-1', status: 'completed', metadata: { url: 'https://starframe-sh.tos-s3-cn-shanghai.volces.com/videos/result.mp4?X-Amz-Signature=fixture' } });
    };
    const output = await bridge.generateVideoFromRenderer(request);
    assert.equal(output.taskId, 'task-real-1');
    assert.equal(fs.readFileSync(output.filePath, 'utf8'), 'fixture video');
    await bridge.resumeVideoFromRenderer({ ...request, taskId: 'task-real-1' });
    assert.deepEqual([posts, polls, downloads], [1, 2, 2]);
    mode = 'failed';
    await assert.rejects(bridge.resumeVideoFromRenderer({ ...request, taskId: 'task-real-1' }), error =>
        error.code === 'UPSTREAM_TASK_FAILED' && error.confirmedFailure === true && !error.message.includes('reference rejected'));
    for (const failure of ['disconnected', 'duplicate']) {
        mode = failure;
        await assert.rejects(bridge.generateVideoFromRenderer(request), error => error.submissionUnknown === true);
    }
    assert.deepEqual(submittedIds, ['stable-1', 'stable-1', 'stable-1']);
    assert.equal(polls, 3, 'No attempt to poll the client id as an upstream task');
});

test('StarFrame mismatched query IDs cannot overwrite the original recovery binding', async () => {
    let rebound = false;
    await assert.rejects(Bridge.pollOpenAiVideoTask('https://starframe.test/v1/videos', 'fixture-key', 'task-original', {}, {
        model: STARFRAME_MODEL, wait: async () => {}, onTaskIdResolved: () => { rebound = true; },
        fetchTask: async () => ({ response: { ok: true, status: 200 }, text: JSON.stringify({ id: 'task-other', status: 'completed',
            metadata: { url: 'https://storage.test/result.mp4' } }) })
    }), /未改绑任务/);
    assert.equal(rebound, false);
});

for (const host of ['art.ravenhash.org', 'cart.ravenhash.org']) {
    test(`StarFrame through ${host} preserves its API binding and recovers normalized results without resubmission`, async t => {
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-starframe-relay-'));
        t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
        const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
        bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
        bridge.attachRecoveredGeneration = async () => ({ nodeId: 'recovered-node' });
        const origin = `https://${host}`;
        const sourceProviderId = `relay-${host}`;
        const clientTaskId = `client-${host}`;
        const taskId = `task-${host.replaceAll('.', '-')}`;
        const apiKey = `fixture-key-${host}`;
        const signedUrl = `https://starframe-sh.tos-s3-cn-shanghai.volces.com/videos/${taskId}.mp4?X-Amz-Signature=fixture`;
        const request = { clientTaskId, prompt: 'relay fixture', duration: 4, ratio: '16:9', resolution: '720p',
            targetDir: profile, addToCanvas: false,
            providerConfig: { id: `${sourceProviderId}::model:${STARFRAME_MODEL}`, sourceProviderId,
                endpoint: `${origin}/v1`, model: STARFRAME_MODEL, capability: 'video', apiKey } };
        let posts = 0, polls = 0, downloads = 0;
        fetchFixture = async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.hostname === 'starframe-sh.tos-s3-cn-shanghai.volces.com') {
                downloads++;
                assert.equal(url, signedUrl);
                assert.equal(new Headers(options.headers).has('authorization'), false);
                return new Response('relay fixture video', { headers: { 'content-type': 'video/mp4' } });
            }
            assert.equal(parsed.origin, origin, 'Requests stay on the original relay');
            assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
            if (options.method === 'POST') {
                posts++;
                assert.equal(url, `${origin}/v1/video/generations`);
                assert.deepEqual(JSON.parse(options.body), { model: STARFRAME_MODEL, client_task_id: clientTaskId,
                    prompt: 'relay fixture', mode: 'references', duration: 4, resolution: '720p', aspect_ratio: '16:9' });
                return json({ id: taskId, object: 'video', status: 'pending', created: 1 });
            }
            assert.equal(options.method, 'GET');
            assert.ok([`/v1/tasks/${taskId}`, `/v1/video/generations/${taskId}`].includes(parsed.pathname));
            assert.equal(parsed.searchParams.get('model'), STARFRAME_MODEL);
            polls++;
            const checkpoint = bridge.recoveryStore.get(clientTaskId);
            assert.equal(checkpoint.taskId, taskId);
            assert.equal(checkpoint.providerId, sourceProviderId);
            assert.equal(checkpoint.endpoint, request.providerConfig.endpoint);
            assert.equal(checkpoint.model, STARFRAME_MODEL);
            assert.equal(JSON.stringify(checkpoint).includes(apiKey), false);
            return json(polls === 1 ? { id: taskId, object: 'video', status: 'in_progress', created: 1 }
                : { id: taskId, object: 'video', status: 'completed', created: 1, data: [{ url: signedUrl }], usage: {} });
        };
        const output = await bridge.generateVideoFromRenderer(request);
        assert.equal(output.taskId, taskId);
        assert.equal(fs.readFileSync(output.filePath, 'utf8'), 'relay fixture video');
        assert.deepEqual([posts, polls, downloads], [1, 2, 1]);
        fs.unlinkSync(output.filePath);
        await assert.rejects(bridge.recoverGenerationFromRenderer({ ...request, kind: 'video', taskId,
            providerConfig: { ...request.providerConfig, id: 'other-account', sourceProviderId: 'other-account' } }), /API/);
        assert.deepEqual([posts, polls, downloads], [1, 2, 1], 'Wrong-account recovery must not make network requests');
        const recovered = await bridge.recoverGenerationFromRenderer({ ...request, kind: 'video', taskId,
            providerConfig: { ...request.providerConfig, endpoint: 'https://changed-endpoint.test/v1', model: 'changed-model' } });
        assert.equal(recovered.taskId, taskId);
        assert.equal(recovered.recovered, true);
        assert.equal(fs.readFileSync(recovered.filePath, 'utf8'), 'relay fixture video');
        assert.deepEqual([posts, polls, downloads], [1, 3, 2], 'Recovery only queries and downloads the original task');
        const checkpoint = bridge.recoveryStore.get(clientTaskId);
        assert.equal(checkpoint.providerId, sourceProviderId);
        assert.equal(checkpoint.endpoint, request.providerConfig.endpoint);
        assert.equal(checkpoint.model, STARFRAME_MODEL);
        assert.equal(checkpoint.state, 'attached');
    });
}

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
