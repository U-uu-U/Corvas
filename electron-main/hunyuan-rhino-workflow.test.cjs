const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { HunyuanRhinoWorkflow } = require('./hunyuan-rhino-workflow.cjs');
const { keyFor } = require('./hunyuan-model-watcher.cjs');
const { toolId } = require('./mcp-client.cjs');

function setup(t, initialJobs) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-hunyuan-workflow-test-'));
    if (initialJobs) fs.writeFileSync(path.join(directory, 'hunyuan-rhino-jobs.json'), JSON.stringify({ version: 1, jobs: initialJobs }));
    const source = path.join(directory, 'model.fbx'); fs.writeFileSync(source, 'fixture');
    const actions = []; let listening = false, state = 'idle';
    const sceneTool = toolId('rhino-fixture', 'rhino_scene');
    const mcpClient = {
        definitions: () => [{ name: sceneTool }], tools: new Map([[sceneTool, { serverId: 'rhino-fixture' }]]),
        call: async (name, input) => {
            assert.equal(name, sceneTool); assert.equal(input.action, 'script');
            const script = /"([^"]+)"/.exec(input.cmd)[1];
            const options = JSON.parse(fs.readFileSync(path.join(path.dirname(script), 'import-options.json'), 'utf8'));
            actions.push({ type: 'import', options });
            fs.writeFileSync(path.join(options.resultDirectory, 'import-result.json'), JSON.stringify({ ok: true,
                jobId: options.jobId, documentId: '42', meshIds: ['fixture-mesh-id'], meshStats: [], faceCount: 100 }));
        }
    };
    const rhino = { config: { endpoint: 'http://127.0.0.1:26929/mcp' }, mcpClient,
        probe: async () => listening, server: () => ({ id: 'rhino-fixture', name: 'Rhino fixture' }),
        status: async () => rhino.snapshot(), snapshot: () => ({ connected: state === 'connected', state, message: '' }),
        open: options => { actions.push({ type: 'open', options }); state = listening ? 'connected' : 'waiting'; rhino.pending = Promise.resolve(); }
    };
    const runtime = { board: { readProject: () => ({}) }, runs: new Map(),
        resolveProvider: () => ({ endpoint: 'http://127.0.0.1', apiKey: 'fixture', model: 'fixture' }),
        start: request => { const run = { ...request, id: randomUUID(), status: 'planning' }; actions.push({ type: 'run', request }); runtime.runs.set(run.id, run); return run; }
    };
    const service = new HunyuanRhinoWorkflow({ directory, getRhino: () => rhino, getRuntime: () => runtime,
        getAccounts: () => ({ downloadModel: async () => { actions.push({ type: 'download' }); return source; } }),
        getProjectId: () => 'fixture-project', readMode: () => 'auto', onChange: () => {} });
    clearInterval(service.timer);
    t.after(() => {
        service.close();
        for (const job of service.jobs) {
            const scriptDir = path.join(os.tmpdir(), 'corvas-hunyuan-rhino', job.id);
            assert.equal(path.dirname(scriptDir), path.join(os.tmpdir(), 'corvas-hunyuan-rhino'));
            fs.rmSync(scriptDir, { recursive: true, force: true });
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const task = { worksId: randomUUID(), generationId: keyFor(randomUUID()), status: 'ready' };
    return { service, rhino, runtime, actions, task, accountId: randomUUID(), connect: () => { listening = true; } };
}

test('handoff waits through a Rhino startup dialog then imports and starts the Skill exactly once', async t => {
    const { service, runtime, actions, task, accountId, connect } = setup(t);
    service.observe(accountId, task);
    const job = service.jobs[0];
    await service.drain();
    assert.equal(job.status, 'waiting_rhino');
    assert.equal(job.importStarted, undefined);
    await service.drain(); await service.drain();
    assert.equal(actions.filter(action => action.type === 'open').length, 1);
    assert.equal(actions.filter(action => action.type === 'import').length, 0);
    connect(); await service.drain(); await service.drain();
    assert.equal(job.status, 'processing');
    assert.equal(actions.filter(action => action.type === 'import').length, 1);
    const runs = actions.filter(action => action.type === 'run');
    assert.equal(runs.length, 1);
    assert.match(runs[0].request.messages[0].content, /fixture-mesh-id/);
    assert.equal(runs[0].request.skillInstructions.length, 1);
    assert.deepEqual(runs[0].request.toolAllowlist, [toolId('rhino-fixture', 'rhino_scene')]);
    runtime.runs.get(job.runId).status = 'completed'; service.syncRuns();
    assert.equal(job.status, 'completed');
});

test('switching a waiting automatic handoff to manual requires confirmation before any import', async t => {
    const { service, actions, task, accountId, connect } = setup(t);
    service.observe(accountId, task); await service.drain();
    service.configure({ mode: 'ask' }); connect(); await service.drain();
    const job = service.jobs[0];
    assert.equal(job.status, 'awaiting_confirmation');
    assert.equal(actions.filter(action => action.type === 'import').length, 0);
    service.action({ id: job.id, action: 'confirm' }); await service.drain();
    assert.equal(actions.filter(action => action.type === 'import').length, 1);
    assert.equal(actions.filter(action => action.type === 'run').length, 1);
});

test('old connection-timeout failures can wait again, but imports with unknown results are never replayed', t => {
    const job = { id: keyFor(randomUUID()), generationId: keyFor(randomUUID()), accountId: randomUUID(),
        worksId: randomUUID(), status: 'failed', error: 'Rhino 已打开，但还未连接。请处理软件内的启动提示。' };
    const unsafe = { ...job, id: keyFor(randomUUID()), importStarted: true };
    const { service } = setup(t, [job, unsafe]);
    assert.equal(service.jobs[0].status, 'waiting_rhino');
    assert.equal(service.jobs[1].status, 'failed');
});
