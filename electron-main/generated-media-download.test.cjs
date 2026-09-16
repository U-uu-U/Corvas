const test = require('node:test');
const assert = require('node:assert/strict');
const Bridge = require('./mcp-bridge');

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
