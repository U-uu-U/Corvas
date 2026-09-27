'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tryGenerateWithOpenAIVideo } = require('./mcp-bridge');

test('video bridge dispatches Shanhai models through the documented generations/tasks contract', async t => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-shanhai-bridge-'));
    t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
    const calls = [];
    const result = await tryGenerateWithOpenAIVideo('A test scene', targetDir, {
        providerConfig: { endpoint: 'https://shanhai.vnshu.cn/api/v1', apiKey: 'fixture-key', model: 'oc-model-qbdmeb' },
        duration: 5, ratio: '16:9', resolution: '720p', fetchImpl: async (url, request = {}) => {
            calls.push({ url, request });
            if (request.method === 'POST') {
                const body = JSON.parse(request.body);
                assert.equal(url, 'https://shanhai.vnshu.cn/api/v1/generations');
                assert.equal(body.media_type, 'video');
                assert.equal(body.options.duration, '5');
                return new Response(JSON.stringify({ id: 'shan-task-1', status: 'queued' }), { status: 202 });
            }
            if (url.endsWith('/tasks/shan-task-1')) {
                assert.equal(request.headers.Authorization, 'Bearer fixture-key');
                return new Response(JSON.stringify({ id: 'shan-task-1', status: 'succeeded', output: { url: 'https://shanhai.vnshu.cn/api/v1/media/runs/shan-task-1' } }));
            }
            assert.equal(url, 'https://shanhai.vnshu.cn/api/v1/media/runs/shan-task-1');
            assert.equal(request.headers.Authorization, 'Bearer fixture-key');
            return new Response('fixture video', { headers: { 'content-type': 'video/mp4' } });
        },
        onDownloaded: event => assert.equal(event.mediaType, 'video')
    });
    assert.equal(result.success, true);
    assert.equal(result.provider, 'shanhai-video');
    assert.equal(result.taskId, 'shan-task-1');
    assert.equal(calls.filter(call => call.request.method === 'POST').length, 1);
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'fixture video');
});

test('video bridge recognizes Dola 30 and defaults to its fixed 30-second duration', async t => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-shanhai-30-bridge-'));
    t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
    const calls = [];
    const result = await tryGenerateWithOpenAIVideo('A 30-second scene', targetDir, {
        providerConfig: { endpoint: 'https://shanhai.vnshu.cn/api/v1', apiKey: 'fixture-key', model: 'oc-model-r5cfh8' },
        ratio: '21:9', resolution: '720p', fetchImpl: async (url, request = {}) => {
            calls.push({ url, request });
            if (request.method === 'POST') {
                assert.equal(url, 'https://shanhai.vnshu.cn/api/v1/generations');
                assert.deepEqual(JSON.parse(request.body), {
                    model: 'oc-model-r5cfh8', prompt: 'A 30-second scene', media_type: 'video',
                    options: { duration: '30', aspect_ratio: '21:9', resolution: '720p' }
                });
                return new Response(JSON.stringify({ id: 'shan-30-task', status: 'queued' }), { status: 202 });
            }
            if (url.endsWith('/tasks/shan-30-task')) {
                return new Response(JSON.stringify({ id: 'shan-30-task', status: 'succeeded', output: { url: 'https://cdn.example/dola-30.mp4' } }));
            }
            assert.equal(url, 'https://cdn.example/dola-30.mp4');
            assert.equal(request.headers.Authorization, undefined);
            return new Response('dola 30 fixture video', { headers: { 'content-type': 'video/mp4' } });
        }
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.provider, 'shanhai-video');
    assert.equal(result.taskId, 'shan-30-task');
    assert.equal(calls.filter(call => call.request.method === 'POST').length, 1);
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'dola 30 fixture video');
});

test('video bridge rejects Dola 30 unsupported references before reading or uploading media', async () => {
    for (const references of [
        { sourceReferences: Array.from({ length: 11 }, () => ({ filePath: 'missing.png' })) },
        { videoReferences: [{ filePath: 'missing.mp4' }] },
        { audioReferences: [{ filePath: 'missing.mp3' }] }
    ]) {
        let calls = 0;
        const result = await tryGenerateWithOpenAIVideo('A test scene', os.tmpdir(), {
            providerConfig: { endpoint: 'https://shanhai.vnshu.cn/api/v1', apiKey: 'fixture-key', model: 'oc-model-r5cfh8' },
            duration: 30, ...references, fetchImpl: async () => { calls += 1; }
        });
        assert.equal(result.success, false);
        assert.match(result.error, /最多支持/);
        assert.equal(calls, 0);
    }
});
