const test = require('node:test');
const assert = require('node:assert/strict');
const { createErrorAnalysisClient } = require('./error-analysis-client.cjs');
test('desktop uses a fixed credential-free lookup and caches safe advice', async () => {
    let calls = 0;
    const client = createErrorAnalysisClient({ fetchImpl: async (url, options) => {
        calls++;
        assert.match(url, /^https:\/\/artconfig\.ravenhash\.org\/error-analysis\/ea_[a-f0-9]{32}$/);
        assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error');
        return new Response(JSON.stringify({ state: 'ready', cause: '图片格式不兼容', evidence: '图片格式无效', suggestion: '检查参考素材', billingState: 'refunded' }));
    } });
    const token = 'ea_' + 'a'.repeat(32);
    const [a, b] = await Promise.all([client.get(token), client.get(token)]);
    assert.equal(calls, 1); assert.deepEqual(a, b); assert.equal(a.billingState, undefined);
    assert.equal((await client.get('https://evil.test')).state, 'unavailable'); assert.equal(calls, 1);
});
