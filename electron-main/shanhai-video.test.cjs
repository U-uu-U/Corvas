'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const {
    isShanhaiEndpoint,
    isShanhaiModel,
    buildShanhaiGenerationBody,
    generateShanhaiVideo,
    resumeShanhaiVideo
} = require('./shanhai-video.cjs');

const ENDPOINT = 'https://shanhai.vnshu.cn/api/v1';
const MODEL = 'oc-model-qbdmeb';
const INPUTS = {
    imageUrls: ['https://assets.example/image.png'],
    videoUrls: ['https://assets.example/video.mp4'],
    audioUrls: ['https://assets.example/audio.mp3']
};

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function videoResponse(value = 'video') {
    return new Response(value, { status: 200, headers: { 'content-type': 'video/mp4' } });
}

function baseOptions(overrides = {}) {
    const output = [];
    return {
        endpoint: ENDPOINT,
        apiKey: 'fixture-key',
        model: MODEL,
        prompt: 'fixture prompt',
        duration: 5,
        ratio: '16:9',
        resolution: '720p',
        targetDir: os.tmpdir(),
        pollIntervalMs: 0,
        writeMedia: async (buffer, details) => {
            output.push({ buffer: Buffer.from(buffer), details });
            return path.join(os.tmpdir(), 'shanhai-fixture.mp4');
        },
        _output: output,
        ...overrides
    };
}

test('recognizes and normalizes the documented endpoint', () => {
    assert.equal(isShanhaiEndpoint(ENDPOINT), true);
    assert.equal(isShanhaiEndpoint(`${ENDPOINT}/`), true);
    assert.equal(isShanhaiEndpoint('http://shanhai.vnshu.cn/api/v1'), false);
    assert.equal(isShanhaiEndpoint('https://other.example/api/v1'), false);
    assert.equal(isShanhaiEndpoint('not-a-url'), false);
});

test('recognizes Shanhai model IDs without accepting unrelated models', () => {
    assert.equal(isShanhaiModel(MODEL), true);
    assert.equal(isShanhaiModel('oc-model-1iq31f'), true);
    assert.equal(isShanhaiModel('shanhai-dola-seedance-v2-5-30-9-0-7'), true);
    assert.equal(isShanhaiModel('shanhai-image-2'), false);
    assert.equal(isShanhaiModel('gpt-image-2'), false);
    assert.equal(isShanhaiModel(''), false);
});

test('builds a mixed multimedia request in stable input order', () => {
    assert.deepEqual(buildShanhaiGenerationBody({ model: 'oc-model-1iq31f', prompt: '  hello ', duration: 5,
        ratio: '9:16', resolution: '1080p', ...INPUTS }), {
        model: 'oc-model-1iq31f', prompt: 'hello', media_type: 'video',
        inputs: [
            { type: 'image', url: INPUTS.imageUrls[0] },
            { type: 'video', url: INPUTS.videoUrls[0] },
            { type: 'audio', url: INPUTS.audioUrls[0] }
        ],
        options: { aspect_ratio: '9:16', resolution: '1080p', duration: '5' }
    });
});

test('omits inputs for text-to-video requests', () => {
    const body = buildShanhaiGenerationBody({ model: MODEL, prompt: 'hello' });
    assert.deepEqual(body.inputs, undefined);
    assert.deepEqual(body.options, { aspect_ratio: '16:9', resolution: '720p', duration: '15' });
});

test('rejects invalid duration, ratio, resolution and empty prompt', () => {
    for (const input of [
        { duration: 3 }, { duration: 31 }, { duration: 1.5 },
        { ratio: '2:1' }, { resolution: '4k' }, { prompt: ' ' }
    ]) assert.throws(() => buildShanhaiGenerationBody({ model: MODEL, ...input }), /Shanhai/);
});

test('applies documented model limits and maps adaptive ratio', () => {
    const adaptive = buildShanhaiGenerationBody({ model: 'oc-model-1iq31f', prompt: 'x', duration: 5, ratio: 'adaptive' });
    assert.equal(adaptive.options.aspect_ratio, '16:9');
    assert.throws(() => buildShanhaiGenerationBody({ model: MODEL, prompt: 'x', duration: 4 }), /时长/);
    assert.throws(() => buildShanhaiGenerationBody({ model: MODEL, prompt: 'x', duration: 5, resolution: '1080p' }), /分辨率/);
    assert.throws(() => buildShanhaiGenerationBody({ model: 'oc-model-bkb50q', prompt: 'x', duration: 4,
        imageUrls: ['https://assets.example/image.png'] }), /不支持参考素材/);
    assert.throws(() => buildShanhaiGenerationBody({ model: 'shanhai-dola-test', prompt: 'x', duration: 5,
        imageUrls: Array.from({ length: 10 }, (_, index) => `https://assets.example/${index}.png`),
        videoUrls: ['https://assets.example/video.mp4'] }), /10 个参考素材/);
});

test('rejects non-HTTPS reference URLs', () => {
    assert.throws(() => buildShanhaiGenerationBody({ model: MODEL, prompt: 'x', imageUrls: ['http://example/image.png'] }), /HTTPS/);
    assert.throws(() => buildShanhaiGenerationBody({ model: MODEL, prompt: 'x', videoUrls: ['data:video/mp4;base64,abc'] }), /HTTPS/);
    assert.throws(() => buildShanhaiGenerationBody({ model: MODEL, prompt: 'x', audioUrls: ['file:///tmp/a.mp3'] }), /HTTPS/);
});

test('submits, polls and downloads with Bearer authentication', async () => {
    const calls = [];
    const options = baseOptions({ onTaskSubmitted: event => calls.push({ type: 'submitted', event }),
        onDownloaded: event => calls.push({ type: 'downloaded', event }), ...INPUTS });
    options.fetchImpl = async (url, request) => {
        calls.push({ url, request });
        if (request.method === 'POST') return jsonResponse({ id: 'task-1', status: 'queued' }, 202);
        if (url.endsWith('/tasks/task-1')) return jsonResponse({ id: 'task-1', status: 'succeeded', output: { url: 'https://cdn.example/result.mp4' } });
        assert.equal(url, 'https://cdn.example/result.mp4');
        return videoResponse('fixture video');
    };
    const result = await generateShanhaiVideo(options);
    assert.equal(result.provider, 'shanhai-video');
    assert.equal(result.taskId, 'task-1');
    assert.equal(result.url, 'https://cdn.example/result.mp4');
    const post = calls.find(call => call.request?.method === 'POST');
    assert.equal(post.request.headers.Authorization, 'Bearer fixture-key');
    assert.deepEqual(JSON.parse(post.request.body).inputs, [
        { type: 'image', url: INPUTS.imageUrls[0] }, { type: 'video', url: INPUTS.videoUrls[0] }, { type: 'audio', url: INPUTS.audioUrls[0] }
    ]);
    const download = calls.find(call => call.url === 'https://cdn.example/result.mp4');
    assert.equal(download.request.headers.Authorization, undefined, 'Cross-origin output URLs must not receive the API key');
    assert.equal(options._output[0].buffer.toString(), 'fixture video');
    assert.equal(calls.filter(call => call.type === 'submitted').length, 1);
});

test('accepts an immediately succeeded submission without status polling', async () => {
    let statusPolls = 0;
    const options = baseOptions({ fetchImpl: async (url, request) => {
        if (request.method === 'POST') return jsonResponse({ id: 'task-immediate', status: 'succeeded', output: { url: 'https://cdn.example/immediate.mp4' } }, 202);
        if (url.includes('/tasks/')) statusPolls += 1;
        return videoResponse();
    } });
    const result = await generateShanhaiVideo(options);
    assert.equal(result.taskId, 'task-immediate');
    assert.equal(statusPolls, 0);
});

test('reports failed remote tasks as confirmed failures', async () => {
    const options = baseOptions({ fetchImpl: async (url, request) => request.method === 'POST'
        ? jsonResponse({ id: 'task-fail', status: 'queued' }, 202)
        : jsonResponse({ id: 'task-fail', status: 'failed', error: { message: 'secret upstream detail' } }) });
    await assert.rejects(generateShanhaiVideo(options), error => error.code === 'SHANHAI_TASK_FAILED'
        && error.confirmedFailure === true && !error.message.includes('secret'));
});

test('retries transient polling failures a finite number of times', async () => {
    let statusPolls = 0;
    const options = baseOptions({ maxRetries: 2, fetchImpl: async (url, request) => {
        if (request.method === 'POST') return jsonResponse({ id: 'task-retry', status: 'queued' }, 202);
        if (url.includes('/tasks/')) statusPolls += 1;
        if (statusPolls < 3) return new Response('busy', { status: 503 });
        if (url.endsWith('/tasks/task-retry')) return jsonResponse({ id: 'task-retry', status: 'succeeded', output: { url: 'https://cdn.example/retry.mp4' } });
        return videoResponse();
    } });
    const result = await generateShanhaiVideo(options);
    assert.equal(result.taskId, 'task-retry');
    assert.equal(statusPolls, 3);
});

test('does not retry polling forever after repeated network failures', async () => {
    let polls = 0;
    const options = baseOptions({ maxRetries: 2, fetchImpl: async (_url, request) => {
        if (request.method === 'POST') return jsonResponse({ id: 'task-network', status: 'queued' }, 202);
        polls += 1; throw new TypeError('network down');
    } });
    await assert.rejects(generateShanhaiVideo(options), error => error.code === 'SHANHAI_STATUS_UNAVAILABLE');
    assert.equal(polls, 3);
});

test('marks a disconnected POST as submission unknown and never retries it', async () => {
    let posts = 0;
    const options = baseOptions({ fetchImpl: async () => { posts += 1; throw new TypeError('connection reset'); } });
    await assert.rejects(generateShanhaiVideo(options), error => error.code === 'SHANHAI_SUBMISSION_UNKNOWN'
        && error.submissionUnknown === true && error.confirmedFailure === false);
    assert.equal(posts, 1);
});

test('marks an accepted response without an ID as submission unknown', async () => {
    let posts = 0;
    const options = baseOptions({ fetchImpl: async () => { posts += 1; return jsonResponse({ status: 'queued' }, 202); } });
    await assert.rejects(generateShanhaiVideo(options), error => error.submissionUnknown === true);
    assert.equal(posts, 1);
});

test('cancellation before submission is safe and makes no request', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(generateShanhaiVideo(baseOptions({ signal: controller.signal, fetchImpl: async () => { calls += 1; } })), error => error.name === 'AbortError');
    assert.equal(calls, 0);
});

test('cancellation during polling stops without downloading', async () => {
    const controller = new AbortController();
    let downloads = 0;
    const options = baseOptions({ signal: controller.signal, fetchImpl: async (url, request) => {
        if (request.method === 'POST') return jsonResponse({ id: 'task-cancel', status: 'queued' }, 202);
        downloads += 1;
        controller.abort();
        return jsonResponse({ id: 'task-cancel', status: 'running' });
    } });
    await assert.rejects(generateShanhaiVideo(options), error => error.name === 'AbortError');
    assert.equal(downloads, 1);
});

test('resume only polls the saved task and never submits a second generation', async () => {
    const calls = [];
    const options = baseOptions({ taskId: 'saved-task', prompt: 'resume prompt', fetchImpl: async (url, request) => {
        calls.push({ url, request });
        if (request.method === 'POST') throw new Error('unexpected POST');
        if (url.endsWith('/tasks/saved-task')) return jsonResponse({ id: 'saved-task', status: 'succeeded', output: { url: 'https://cdn.example/saved.mp4' } });
        return videoResponse('resumed video');
    } });
    const result = await resumeShanhaiVideo(options);
    assert.equal(result.taskId, 'saved-task');
    assert.equal(calls.filter(call => call.request.method === 'POST').length, 0);
    assert.equal(calls[0].url, `${ENDPOINT}/tasks/saved-task`);
    assert.equal(calls[0].request.headers.Authorization, 'Bearer fixture-key');
});

test('resume requires a task ID', async () => {
    await assert.rejects(resumeShanhaiVideo(baseOptions()), /任务 ID/);
});

test('strips the API key after a cross-origin output redirect', async () => {
    const requests = [];
    const options = baseOptions({ fetchImpl: async (url, request) => {
        requests.push({ url, request });
        if (request.method === 'POST') return jsonResponse({ id: 'task-redirect', status: 'queued' }, 202);
        if (url.endsWith('/tasks/task-redirect')) return jsonResponse({ id: 'task-redirect', status: 'succeeded', output: { url: 'https://shanhai.vnshu.cn/files/result.mp4' } });
        if (url === 'https://shanhai.vnshu.cn/files/result.mp4') return new Response('', {
            status: 302, headers: { location: 'https://cdn.example/result.mp4' }
        });
        assert.equal(url, 'https://cdn.example/result.mp4');
        return videoResponse('redirected video');
    } });
    await generateShanhaiVideo(options);
    const first = requests.find(entry => entry.url === 'https://shanhai.vnshu.cn/files/result.mp4');
    const second = requests.find(entry => entry.url === 'https://cdn.example/result.mp4');
    assert.equal(first.request.headers.Authorization, 'Bearer fixture-key');
    assert.equal(second.request.headers.Authorization, undefined);
});

test('rejects non-HTTPS output URLs before download', async () => {
    let downloads = 0;
    const options = baseOptions({ fetchImpl: async (url, request) => {
        if (request.method === 'POST') return jsonResponse({ id: 'task-output', status: 'queued' }, 202);
        downloads += 1;
        return jsonResponse({ id: 'task-output', status: 'succeeded', output: { url: 'http://cdn.example/result.mp4' } });
    } });
    await assert.rejects(generateShanhaiVideo(options), /必须使用 HTTPS/);
    assert.equal(downloads, 1);
});

test('redacts API failures and preserves task callback data without the key', async () => {
    const submitted = [];
    const options = baseOptions({ clientTaskId: 'client-123', onTaskSubmitted: event => submitted.push(event),
        fetchImpl: async (_url, request) => request.method === 'POST'
            ? jsonResponse({ id: 'task-redact', status: 'queued' }, 202)
            : new Response('gateway failure', { status: 500 }) });
    await assert.rejects(generateShanhaiVideo(options), error => error.code === 'SHANHAI_HTTP_ERROR'
        && !error.message.includes('fixture-key'));
    assert.equal(submitted[0].taskId, 'task-redact');
    assert.equal(JSON.stringify(submitted).includes('fixture-key'), false);
});
