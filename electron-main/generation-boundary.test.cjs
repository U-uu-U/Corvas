const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { MediaAccessPolicy } = require('./media-access.cjs');
let profile, fetchFixture, Bridge;
const originalLoad = Module._load;
try {
    Module._load = function (name, ...args) {
        return name === 'electron' ? { app: { getPath: () => profile }, net: { fetch: (...args) => fetchFixture(...args) } }
            : originalLoad.call(this, name, ...args);
    };
    Bridge = require('./mcp-bridge');
} finally { Module._load = originalLoad; }

test('accepted video responses without usable task identity are uncertain and never resubmitted', async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-submission-boundary-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    for (const body of ['<html>gateway</html>', '{}']) {
        let posts = 0;
        fetchFixture = async (_url, request) => { assert.equal(request.method, 'POST'); posts++; return new Response(body, { status: 202 }); };
        await assert.rejects(bridge._generateVideoFromRenderer({ prompt: 'fixture', clientTaskId: 'client-fixture',
            targetDir: profile, addToCanvas: false, duration: 4, ratio: '16:9', resolution: '720p',
            providerConfig: { endpoint: 'https://video-fixture.test/v1', model: 'seedance-2.5-pro', apiKey: 'fixture-only' } }),
        error => error.code === 'RH_SUBMISSION_UNKNOWN' && error.submissionUnknown === true && error.requestId === 'client-fixture');
        assert.equal(posts, 1);
    }
});

test('generated and checkpointed files receive persistent preview access in a new output directory', async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-output-access-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const settings = { userData: path.join(profile, 'app'), registryFile: path.join(profile, 'app', 'grants.json') };
    const policy = new MediaAccessPolicy(settings);
    const output = path.join(profile, 'output.mp4');
    const cached = path.join(profile, 'cached.mp4');
    fs.writeFileSync(output, 'fixture'); fs.writeFileSync(cached, 'fixture');
    await assert.rejects(policy.resolve(output));
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records'),
        registerMediaFile: file => policy.grant(file) });
    bridge._rememberResult({ clientTaskId: 'created', kind: 'video' }, { filePath: output, mediaType: 'video' });
    assert.equal((await policy.resolve(output)).filePath, output);
    bridge.recoveryStore.update('cached', { kind: 'video', result: { filePath: cached, mediaType: 'video' }, state: 'downloaded' });
    bridge.attachRecoveredGeneration = async () => ({ nodeId: 'node' });
    await bridge.recoverGenerationFromRenderer({ clientTaskId: 'cached', kind: 'video' });
    const restarted = new MediaAccessPolicy(settings);
    assert.equal((await restarted.resolve(cached)).filePath, cached);
    assert.equal((await restarted.resolve(output)).filePath, output);
});
