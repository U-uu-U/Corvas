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
