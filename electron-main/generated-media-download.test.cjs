const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
let fetchFixture;
let Bridge;
const originalLoad = Module._load;
try {
    Module._load = function (name, ...args) {
        return name === 'electron' ? { net: { fetch: (...args) => fetchFixture(...args) } }
            : originalLoad.call(this, name, ...args);
    };
    Bridge = require('./mcp-bridge');
} finally { Module._load = originalLoad; }

test('视频产物下载鉴权失败后每15秒自动刷新任务地址', async () => {
    let downloads = 0;
    let polls = 0;
    const waits = [];
    const result = await Bridge.downloadVideoWithAutoRefresh(
        { url: 'https://cdn.example/expired.mp4', taskId: 'task_9248' },
        'C:/output',
        'test',
        {
            generationEndpoint: 'https://relay.example/v1/videos',
            apiKey: 'test-key',
            model: 'seedance_v2.5',
            download: async url => {
                downloads++;
                if (downloads === 1) throw Object.assign(new Error('HTTP 401'), { status: 401 });
                assert.equal(url, 'https://cdn.example/refreshed.mp4');
                return 'C:/output/result.mp4';
            },
            wait: async milliseconds => waits.push(milliseconds),
            poll: async (_endpoint, _key, taskId) => {
                polls++;
                assert.equal(taskId, 'task_9248');
                return { url: 'https://cdn.example/refreshed.mp4', taskId };
            }
        }
    );

    assert.equal(result, 'C:/output/result.mp4');
    assert.equal(downloads, 2);
    assert.equal(polls, 1);
    assert.deepEqual(waits, [15_000]);
});

test('real download error retains HTTP status and refreshes an expired URL without resubmitting', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-download-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const fetched = [];
    fetchFixture = async (url, options) => {
        fetched.push(url);
        assert.equal(options.method, 'GET');
        if (url.endsWith('/expired.mp4')) return new Response('', { status: 401 });
        return new Response('video-fixture', { headers: { 'content-type': 'video/mp4' } });
    };
    let polls = 0;
    const result = await Bridge.downloadVideoWithAutoRefresh({ url: 'https://cdn.example/expired.mp4', taskId: 'task_test' },
        directory, 'fixture', {
            wait: async () => {}, poll: async (_endpoint, _key, id) => {
                polls++;
                assert.equal(id, 'task_test');
                return { url: 'https://cdn.example/fresh.mp4', taskId: id };
            }
        });
    assert.equal(polls, 1);
    assert.deepEqual(fetched, ['https://cdn.example/expired.mp4', 'https://cdn.example/fresh.mp4']);
    assert.equal(fs.readFileSync(result, 'utf8'), 'video-fixture');
});

test('persistent download denial stops refreshing after three queries and preserves recoverable error metadata', async () => {
    fetchFixture = async () => new Response('', { status: 403 });
    let polls = 0;
    await assert.rejects(Bridge.downloadVideoWithAutoRefresh({ url: 'https://cdn.example/expired.mp4', taskId: 'task_test' },
        'unused', 'fixture', { wait: async () => {}, poll: async () => {
            polls++;
            return { url: 'https://cdn.example/expired.mp4', taskId: 'task_test' };
        } }), error => error.code === 'DOWNLOAD_FAILED' && error.status === 403 && error.retryable);
    assert.equal(polls, 3);
});
