const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { publicFailure } = require('../shared/public-api-error.cjs');
const { imageHttpErrorMessage, imageTaskErrorMessage } = require('./openai-image-request');
const { getVideoPayloadError } = require('./video-provider-adapters');
const { callAgentProvider } = require('./agent-provider.cjs');
const requestId = 'rh_' + 'b'.repeat(32);
const failure = publicFailure(502, { error: 'vendor-secret.internal' }, { requestId });

test('image/video display public errors without raw JSON or supplier metadata', () => {
    const body = { ...failure.body, debug: 'vendor-secret.internal' };
    for (const message of [imageHttpErrorMessage(502, JSON.stringify(body)), imageTaskErrorMessage(body), getVideoPayloadError(body)]) {
        assert.match(message, new RegExp(requestId));
        assert.doesNotMatch(message, /vendor-secret|ravenhash_error|\{"/);
    }
});

test('Agent preserves public error identity and unknown-outcome markers', async () => {
    let calls = 0;
    await assert.rejects(() => callAgentProvider({ provider: { type: 'openai', endpoint: 'https://mock.test/v1', model: 'mock', apiKey: 'fixture' },
        messages: [{ role: 'user', content: 'test' }], fetchImpl: async () => {
            calls++;
            return new Response(JSON.stringify(failure.body), { status: 502 });
        } }), error => error.code === 'RH_SUBMISSION_UNKNOWN' && error.submissionUnknown && error.requestId === requestId);
    assert.equal(calls, 1);
});

test('Agent still degrades once when gateway reports unsupported tools', async () => {
    let calls = 0;
    const result = await callAgentProvider({ provider: { type: 'openai', endpoint: 'https://mock.test/v1', model: 'mock', apiKey: 'fixture' },
        messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: { name: 'test', parameters: { type: 'object' } } }],
        fetchImpl: async (_url, init) => {
            if (++calls === 1) return new Response(JSON.stringify(publicFailure(400, { error: 'tools not supported' }, { requestId }).body), { status: 400 });
            assert.equal(JSON.parse(init.body).tools, undefined);
            return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }] }));
        } });
    assert.equal(result.toolSupport, 'unavailable');
    assert.equal(calls, 2);
});

test('image/video submission does not retry a mapped uncertain result and preserves the flag', async t => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-public-error-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    let calls = 0;
    const originalLoad = Module._load;
    let Bridge;
    try {
        Module._load = function (name, ...args) {
            return name === 'electron' ? { app: { getPath: () => profile }, net: { fetch: async () => {
                calls++;
                return new Response(JSON.stringify(failure.body), { status: 502 });
            } } } : originalLoad.call(this, name, ...args);
        };
        Bridge = require('./mcp-bridge');
    } finally { Module._load = originalLoad; }
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    for (const kind of ['image', 'video']) {
        const before = calls;
        const config = { prompt: 'fixture', duration: 30, targetDir: profile, addToCanvas: false,
            provider: kind === 'image' ? 'openai' : 'openai-video', providerConfig: { endpoint: 'https://mock.test/v1', apiKey: 'fixture', model: kind === 'image' ? 'gpt-image-2' : 'sd2.5' } };
        await assert.rejects(() => kind === 'image' ? bridge._generateImageFromRenderer(config) : bridge._generateVideoFromRenderer(config),
            error => error.code === 'RH_SUBMISSION_UNKNOWN' && error.submissionUnknown === true && error.requestId === requestId);
        assert.equal(calls - before, 1);
    }
});
