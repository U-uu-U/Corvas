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
    assert.equal((await policy.resolve(output)).filePath, await fs.promises.realpath(output));
    bridge.recoveryStore.update('cached', { kind: 'video', result: { filePath: cached, mediaType: 'video' }, state: 'downloaded' });
    bridge.attachRecoveredGeneration = async () => ({ nodeId: 'node' });
    await bridge.recoverGenerationFromRenderer({ clientTaskId: 'cached', kind: 'video' });
    const restarted = new MediaAccessPolicy(settings);
    assert.equal((await restarted.resolve(cached)).filePath, await fs.promises.realpath(cached));
    assert.equal((await restarted.resolve(output)).filePath, await fs.promises.realpath(output));
});

test('ordinary video generation downloads privately and returns local products through renderer and MCP boundaries', async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-private-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const privateUrl = 'https://private-cdn.test/video.mp4?signature=provider-secret';
    const calls = [], completed = [];
    fetchFixture = async (url, request) => {
        calls.push({ url, method: request.method });
        if (request.method === 'POST') return Response.json({ id: 'private-task', status: 'completed', video_url: privateUrl });
        assert.equal(url, privateUrl);
        return new Response('downloaded-video', { headers: { 'content-type': 'video/mp4' } });
    };
    const bridge = new Bridge({ store: { load: () => ({ activeGroupId: 'project', items: [] }) },
        recoveryDirectory: path.join(profile, 'records'), notifyTaskCompleted: event => completed.push(event) });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    const result = await bridge._generateVideo({ prompt: 'fixture', clientTaskId: 'client', kind: 'video',
        targetDir: profile, addToCanvas: false, duration: 4, ratio: '16:9', resolution: '720p',
        providerConfig: { id: 'api', endpoint: 'https://relay-fixture.test/v1', model: 'seedance_v2.5', apiKey: 'fixture-only' } });
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'downloaded-video');
    assert.equal(result.taskId, 'private-task');
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(calls.filter(call => call.url === privateUrl).length, 1);
    for (const value of [result, completed, bridge.recoveryStore.list(), bridge.recoveryStore.get('client').result]) {
        assert.doesNotMatch(JSON.stringify(value), /private-cdn|provider-secret/);
    }
});

for (const hasLocalFile of [true, false]) {
    test(`legacy video checkpoint ${hasLocalFile ? 'reuse' : 'redownload'} removes output addresses and retains the original query route`, async t => {
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-legacy-'));
        t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
        const recoveryDirectory = path.join(profile, 'records');
        fs.mkdirSync(recoveryDirectory);
        const filePath = path.join(profile, 'old.mp4');
        if (hasLocalFile) fs.writeFileSync(filePath, 'cached-video');
        const privateUrl = 'https://private-cdn.test/old.mp4?signature=legacy-secret';
        const location = '/v1/custom/tasks/original-task';
        const legacy = { kind: 'video', clientTaskId: 'legacy', taskId: 'original-task', projectId: 'original-project',
            nodeId: 'node', endpoint: 'https://original-api.test/v1', providerId: 'api', model: 'original-model', location,
            state: 'downloaded', result: { filePath, filePaths: [filePath], taskId: 'original-task', mediaType: 'video',
                url: privateUrl, video: { url: privateUrl }, rawResponse: { url: privateUrl } } };
        const recordName = require('node:crypto').createHash('sha256').update('legacy').digest('hex') + '.json';
        fs.writeFileSync(path.join(recoveryDirectory, recordName), JSON.stringify(legacy));
        const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory });
        let queries = 0, attachments = 0;
        bridge.generateVideoFromRenderer = () => assert.fail('recovery must never submit again');
        bridge._resumeVideoFromRenderer = async request => {
            queries++;
            assert.equal(request.providerConfig.endpoint, legacy.endpoint);
            assert.equal(request.providerConfig.model, legacy.model);
            assert.equal(request.location, location);
            assert.equal(request.taskId, legacy.taskId);
            fs.writeFileSync(filePath, 'redownloaded-video');
            return structuredClone(legacy.result);
        };
        bridge.attachRecoveredGeneration = async (request, result) => {
            attachments++;
            assert.equal(request.projectId, legacy.projectId);
            assert.doesNotMatch(JSON.stringify(result), /private-cdn|legacy-secret/);
            return { nodeId: 'node', projectId: request.projectId };
        };
        const result = await bridge.recoverGenerationFromRenderer({ clientTaskId: 'legacy', kind: 'video',
            providerConfig: { id: 'api', endpoint: 'https://changed-api.test/v1', model: 'wrong-model', apiKey: 'fixture-only' } });
        assert.equal(queries, hasLocalFile ? 0 : 1);
        assert.equal(attachments, 1);
        assert.equal(result.filePath, filePath);
        assert.equal(result.taskId, legacy.taskId);
        assert.equal(result.recovered, true);
        assert.doesNotMatch(JSON.stringify(result), /private-cdn|legacy-secret/);
        const saved = JSON.parse(fs.readFileSync(path.join(recoveryDirectory, recordName), 'utf8'));
        assert.doesNotMatch(JSON.stringify(saved.result), /private-cdn|legacy-secret/);
        assert.equal(saved.location, location);
        assert.equal(saved.endpoint, legacy.endpoint);
        assert.equal(saved.state, 'attached');
    });
}
