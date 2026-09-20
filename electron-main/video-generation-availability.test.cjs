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
        ['https://api.xzapi.vip/v1', 'ch0107-sd-2.5-720p'],
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

test('pause policy is scoped to the configured host and exact model', async () => {
    const { isVideoGenerationAvailable } = await import('../shared/video-generation-availability.mjs');
    for (const provider of [
        { endpoint: 'https://art.ravenhash.org', model: 'seedance-2.5-pro' },
        { endpoint: 'https://art.ravenhash.org', model: 'sd2.5' },
        { endpoint: 'https://other.test', model: 'seedance_v2.5-101010' },
        { endpoint: 'https://api.xzapi.vip.example', model: 'ch0107-sd-2.5-720p' }
    ]) assert.equal(isVideoGenerationAvailable(provider), true);
});

test('Agent hides paused models but still resolves saved task bindings', async () => {
    const { AgentGeneration } = await import('./agent-generation.mjs');
    const provider = { id: 'relay', endpoint: 'https://art.ravenhash.org/v1', apiKey: 'fixture-only',
        capability: 'video', models: ['seedance_v2.5-101010', 'sd2.5', 'seedance-2.5-pro'] };
    const agent = new AgentGeneration({ loadConfig: () => ({ providers: [provider] }) });
    assert.deepEqual(agent.listModels().map(m => m.model), ['sd2.5', 'seedance-2.5-pro']);
    assert.equal(agent.resolveProvider({ providerId: 'relay', model: 'seedance_v2.5-101010' }, 'video').model, 'seedance_v2.5-101010');
    agent.board = { readProject: () => ({ items: [{ id: 'node', kind: 'op', nodeType: 'video',
        config: { providerId: 'relay', model: 'seedance_v2.5-101010', prompt: 'fixture' } }], connections: [] }) };
    assert.throws(() => agent.prepare({ projectId: 'fixture', source: {} }, { nodeIds: ['node'] }), { code: 'VIDEO_MODEL_PAUSED' });
});
