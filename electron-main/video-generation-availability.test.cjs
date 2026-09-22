const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let fetchFixture;
let profile;
const originalLoad = Module._load;
let Bridge;
try {
    Module._load = function (name, ...args) {
        return name === 'electron' ? { app: { getPath: () => profile }, net: { fetch: (...args) => fetchFixture(...args) } }
            : originalLoad.call(this, name, ...args);
    };
    Bridge = require('./mcp-bridge');
} finally { Module._load = originalLoad; }

test('paused channels reject new submissions but retain HM task recovery', async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-paused-video-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    let requests = 0;
    fetchFixture = async () => { requests++; throw new Error('No network expected'); };
    const models = [
        ['https://art.ravenhash.org/v1', 'seedance_v2.5-101010'],
        ['https://art.ravenhash.org/v1', 'seedance_v2.5-301010'],
        ['https://zcbservice.aizfw.cn/kyyReactApiServer/v2/model-center/tasks', 'sd_2.5_discount_v1']
    ];
    for (const [endpoint, model] of models) {
        await assert.rejects(bridge._generateVideoFromRenderer({ prompt: 'fixture', targetDir: profile,
            addToCanvas: false, providerConfig: { endpoint, model, apiKey: 'fixture-only' } }), { code: 'VIDEO_MODEL_PAUSED' });
    }
    assert.equal(requests, 0);
    fetchFixture = async (url, options = {}) => {
        assert.notEqual(options.method, 'POST');
        requests++;
        return url.endsWith('/output.mp4') ? new Response('fixture video') : new Response(JSON.stringify({
            id: 'existing-task', status: 'completed', video_url: 'https://art.ravenhash.org/output.mp4'
        }), { headers: { 'content-type': 'application/json' } });
    };
    const result = await bridge._resumeVideoFromRenderer({ taskId: 'existing-task', prompt: 'fixture', targetDir: profile,
        addToCanvas: false, providerConfig: { endpoint: models[0][0], model: models[0][1], apiKey: 'fixture-only' } });
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'fixture video');
    assert.equal(requests, 2);
});

test('StarFrame accepts new submissions on its real host and recovers without resubmitting', async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-starframe-enabled-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    const taskId = 'task_starframe_fixture';
    let posts = 0;
    let polls = 0;
    let downloads = 0;
    fetchFixture = async (url, options = {}) => {
        assert.equal(new URL(url).hostname, 'api.xzapi.vip');
        assert.equal(options.headers.Authorization, 'Bearer fixture-only');
        if (url.endsWith('/content')) {
            assert.equal(url, `https://api.xzapi.vip/v1/videos/${taskId}/content`);
            downloads++;
            return new Response('fixture video', { headers: { 'content-type': 'video/mp4' } });
        }
        if (options.method === 'POST') {
            posts++;
            assert.equal(url, 'https://api.xzapi.vip/v1/videos');
            assert.deepEqual(JSON.parse(options.body), { model: 'ch0107-sd-2.5-720p',
                client_task_id: 'starframe-client-fixture', prompt: 'fixture', mode: 'references',
                duration: 4, resolution: '720p', aspect_ratio: '16:9' });
        } else {
            polls++;
            assert.equal(options.method, 'GET');
            assert.equal(new URL(url).pathname, `/v1/videos/${taskId}`);
        }
        return new Response(JSON.stringify({ id: taskId, status: 'completed' }), {
            headers: { 'content-type': 'application/json' }
        });
    };
    const request = { clientTaskId: 'starframe-client-fixture', prompt: 'fixture', duration: 4,
        resolution: '720p', ratio: '16:9', targetDir: profile, addToCanvas: false,
        providerConfig: { endpoint: 'https://api.xzapi.vip/v1', model: 'ch0107-sd-2.5-720p', apiKey: 'fixture-only' } };
    const generated = await bridge._generateVideoFromRenderer(request);
    assert.equal(generated.taskId, taskId);
    assert.equal(fs.readFileSync(generated.filePath, 'utf8'), 'fixture video');
    const recovered = await bridge._resumeVideoFromRenderer({ ...request, taskId });
    assert.equal(fs.readFileSync(recovered.filePath, 'utf8'), 'fixture video');
    assert.deepEqual([posts, polls, downloads], [1, 1, 2]);
});

test('pause policy is scoped to the configured host and exact model', async () => {
    const { isVideoGenerationAvailable } = await import('../shared/video-generation-availability.mjs');
    for (const provider of [
        { endpoint: 'https://art.ravenhash.org', model: 'seedance-2.5-pro' },
        { endpoint: 'https://art.ravenhash.org', model: 'sd2.5' },
        { endpoint: 'https://api.xzapi.vip/v1', model: 'ch0107-sd-2.5-720p' },
        { endpoint: 'https://other.test', model: 'seedance_v2.5-101010' },
        { endpoint: 'https://api.xzapi.vip.example', model: 'ch0107-sd-2.5-720p' }
    ]) assert.equal(isVideoGenerationAvailable(provider), true);
});

test('Agent lists restored StarFrame, hides other paused models and resolves saved task bindings', async () => {
    const { AgentGeneration } = await import('./agent-generation.mjs');
    const provider = { id: 'relay', endpoint: 'https://art.ravenhash.org/v1', apiKey: 'fixture-only',
        capability: 'video', models: ['seedance_v2.5-101010', 'seedance_v2.5-301010', 'sd2.5', 'seedance-2.5-pro'] };
    const starframe = { id: 'starframe', endpoint: 'https://api.xzapi.vip/v1', apiKey: 'fixture-only',
        capability: 'video', model: 'ch0107-sd-2.5-720p' };
    const globalaiopc = { id: 'globalaiopc', endpoint: 'https://zcbservice.aizfw.cn/kyyReactApiServer',
        apiKey: 'fixture-only', capability: 'video', model: 'sd_2.5_discount_v1' };
    const agent = new AgentGeneration({ loadConfig: () => ({ providers: [provider, starframe, globalaiopc] }) });
    assert.deepEqual(agent.listModels().map(m => m.model), ['sd2.5', 'seedance-2.5-pro', starframe.model]);
    assert.equal(agent.resolveProvider({ providerId: starframe.id, model: starframe.model }, 'video').id, starframe.id);
    assert.equal(agent.resolveProvider({ providerId: 'relay', model: 'seedance_v2.5-101010' }, 'video').model, 'seedance_v2.5-101010');
    agent.board = { readProject: () => ({ items: [{ id: 'node', kind: 'op', nodeType: 'video',
        config: { providerId: 'relay', model: 'seedance_v2.5-101010', prompt: 'fixture' } }], connections: [] }) };
    assert.throws(() => agent.prepare({ projectId: 'fixture', source: {} }, { nodeIds: ['node'] }), { code: 'VIDEO_MODEL_PAUSED' });
});
