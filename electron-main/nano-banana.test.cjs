const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const sharp = require('sharp');
const { NANO_BANANA_MODEL } = require('../shared/nano-banana.cjs');
const { buildNanoBananaEndpoint, buildNanoBananaRequest, normalizeNanoBananaResponse } = require('./nano-banana.cjs');

test('Nano Banana uses native Gemini requests with real reference MIME and explicit image options', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#509d86' } }).jpeg().toBuffer();
    const request = await buildNanoBananaRequest('fixture', [{ buffer: jpeg, mimeType: 'image/png' }], { resolutionTier: '4K', ratio: '16:9', quality: 'high', stream: true, n: 1 });
    assert.equal(request.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
    assert.deepEqual(request.generationConfig.imageConfig, { imageSize: '4K', aspectRatio: '16:9' });
    assert.deepEqual(Object.keys(request).sort(), ['contents', 'generationConfig']);
    assert.equal(buildNanoBananaEndpoint('https://ai.ravenhash.org/v1', NANO_BANANA_MODEL),
        'https://ai.ravenhash.org/v1beta/models/gemini-nano-banana-2.1:generateContent');
    assert.equal(new URL(buildNanoBananaEndpoint('https://fixture.test/proxy/v1?key=private', NANO_BANANA_MODEL)).search, '');
    const automatic = await buildNanoBananaRequest('fixture', [], { size: '2K', ratio: 'adaptive' });
    assert.deepEqual(automatic.generationConfig.imageConfig, { imageSize: '2K' });
    for (const options of [{ resolutionTier: '8K' }, { ratio: '2:1' }, { n: 2 }]) {
        await assert.rejects(buildNanoBananaRequest('fixture', [], options), error => error.submissionState === 'not_submitted');
    }
});

test('native Gemini image extraction ignores text and thought images and reports blocked/empty results', () => {
    const result = normalizeNanoBananaResponse({ candidates: [{ content: { parts: [
        { text: 'Do not treat text as a media URL' }, { thought: true, inlineData: { mimeType: 'image/png', data: 'thought' } },
        { inlineData: { mimeType: 'image/png', data: 'result' } }, { inline_data: { mime_type: 'image/jpeg', data: 'second' } }
    ] } }] });
    assert.deepEqual(result, { data: [{ b64_json: 'result' }, { b64_json: 'second' }] });
    assert.equal(normalizeNanoBananaResponse({ promptFeedback: { blockReason: 'SAFETY' } }).error.code, 'content_policy_violation');
    assert.equal(normalizeNanoBananaResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'No image' }] } }] }).status, 'failed');
});

test('the real bridge posts native JSON once and saves the returned image to disk', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-nano-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const png = await sharp({ create: { width: 80, height: 48, channels: 3, background: '#5994af' } }).png().toBuffer();
    const source = path.join(directory, 'reference.png'); fs.writeFileSync(source, png);
    let calls = 0;
    const wrapper = vm.runInNewContext(`(function(require,module){${fs.readFileSync(path.join(__dirname, 'mcp-bridge.js'), 'utf8')}\nreturn tryGenerateWithOpenAI;})`,
        { Buffer, URL, AbortController, console, process: { env: {} }, setTimeout, clearTimeout });
    const run = wrapper(name => name === 'electron' ? { net: { fetch: async (url, options) => {
        calls++;
        assert.equal(url, 'https://ai.ravenhash.org/v1beta/models/gemini-nano-banana-2.1:generateContent');
        assert.equal(options.headers.Authorization, 'Bearer fixture-key');
        assert.equal(options.headers['Content-Type'], 'application/json');
        const body = JSON.parse(options.body);
        assert.equal(body.contents[0].parts[1].inlineData.data, png.toString('base64'));
        assert.deepEqual(body.generationConfig.imageConfig, { imageSize: '2K', aspectRatio: '3:2' });
        return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] });
    } } } : require(name), { exports: {} });
    const result = await run('fixture prompt', directory, { providerConfig: { model: NANO_BANANA_MODEL, endpoint: 'https://ai.ravenhash.org/v1', apiKey: 'fixture-key' },
        sourceReferences: [{ filePath: source }], resolutionTier: '2K', size: '2K', ratio: '3:2', n: 1 });
    assert.equal(result.success, true, result.error);
    assert.equal(calls, 1);
    assert.equal(result.endpointMode, 'gemini-image');
    assert.equal(result.actualSize, '80x48');
    assert.deepEqual(fs.readFileSync(result.filePath), png);
});
