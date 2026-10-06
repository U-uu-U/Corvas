const test = require('node:test');
const assert = require('node:assert/strict');
const { readGeneratedMediaBody } = require('./generated-media-stream.cjs');

test('streaming enforces the actual limit even when the content length is absent', async () => {
    let canceled = false;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(12)); },
        cancel() { canceled = true; } }));
    await assert.rejects(readGeneratedMediaBody(response, { maxBytes: 10 }), error => error.retryable === false);
    assert.equal(canceled, true);
});

test('truncated identity responses are not saved as complete media', async () => {
    await assert.rejects(readGeneratedMediaBody(new Response('short', { headers: { 'content-length': '100' } }),
        { maxBytes: 200 }), /下载不完整/);
});

test('decoded compressed bytes are not compared with the wire content length', async () => {
    const result = await readGeneratedMediaBody(new Response('decoded bytes', { headers: {
        'content-length': '5', 'content-encoding': 'gzip'
    } }), { maxBytes: 100 });
    assert.equal(result.toString(), 'decoded bytes');
});
