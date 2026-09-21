const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WorkflowService } = require('./workflow-service.cjs');
const { HunyuanRhinoWorkflow } = require('./hunyuan-rhino-workflow.cjs');
const { keyFor } = require('./hunyuan-model-watcher.cjs');

function setup(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-workflow-service-'));
    const accountId = randomUUID(), generationId = keyFor(randomUUID());
    const source = { accountId, generationId, worksId: 'model-work', label: 'Current model' };
    const events = [], calls = [];
    let downloadGate;
    const runtime = { runs: new Map(), controllers: new Map(), board: { readProject: id => {
        if (id !== null && !['project-a', 'project-b'].includes(id)) throw new Error('Project missing');
    } }, cancel: ({ runId }) => { runtime.runs.get(runId).status = 'canceled'; },
    resume: ({ runId }) => { calls.push('resume'); const run = runtime.runs.get(runId); run.status = 'running'; return run; } };
    const accounts = { account: id => { assert.equal(id, accountId); },
        list: () => ({ accounts: [{ id: accountId, name: 'fixture', windowOpen: true }] }),
        currentModel: async id => { assert.equal(id, accountId); return source; },
        modelSource: (id, generation) => { assert.equal(id, accountId); assert.equal(generation, generationId); return source; },
        downloadModel: async () => { calls.push('download'); if (downloadGate) await downloadGate; return path.join(directory, 'model.fbx'); } };
    const rhino = { open: () => calls.push('open'), pending: Promise.resolve(), snapshot: () => ({ connected: false, state: 'waiting' }),
        status: async () => rhino.snapshot(), config: { endpoint: 'http://127.0.0.1:1/mcp' }, probe: async () => false };
    const makeWorkflow = () => {
        const workflow = new HunyuanRhinoWorkflow({ directory, getRuntime: () => runtime, getAccounts: () => accounts,
            getRhino: () => rhino, getProjectId: () => 'project-a', readMode: () => 'auto', onChange: state => events.push(state) });
        clearInterval(workflow.timer); return workflow;
    };
    let workflow = makeWorkflow();
    const service = new WorkflowService({ directory, getRuntime: () => runtime, getAccounts: () => accounts, getWorkflow: () => workflow });
    t.after(() => { workflow.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const request = { workflowId: 'hunyuan-rhino-cleanup', version: 1, projectId: 'project-a',
        requestId: 'request-a', source: { accountId, generationId }, parameters: { targetQuads: 1000 } };
    return { service, runtime, accounts, rhino, directory, calls, request, workflow: () => workflow,
        reload: () => { workflow.close(); workflow = makeWorkflow(); },
        holdDownload: () => { let release; downloadGate = new Promise(resolve => { release = resolve; }); return release; },
        call: (action, args = {}) => service.execute(`flow_canvas.workflow.${action}`, args) };
}

test('MCP workflow discovery exposes versioned fixed steps and an actual current model source', async t => {
    const h = setup(t);
    assert.equal(h.call('list').requiresTextProvider, false);
    assert.equal(h.call('get', { workflowId: h.request.workflowId }).version, 1);
    assert.equal((await h.call('sources')).sources[0].generationId, h.request.source.generationId);
    assert.throws(() => h.call('run', { ...h.request, projectId: undefined }), /参数无效/);
    assert.throws(() => h.call('run', { ...h.request, version: 2 }), { code: 'WORKFLOW_VERSION_CHANGED' });
});

test('external workflow mode persists independently of the internal Agent mode', t => {
    const h = setup(t);
    assert.equal(h.call('list').mode, 'auto');
    assert.equal(h.call('configure', { mode: 'ask' }).mode, 'ask');
    h.reload();
    assert.equal(h.call('list').mode, 'ask');
    h.workflow().configure({ projectId: 'project-a', conversationId: 'canvas-conversation' });
    assert.equal(h.call('list').mode, 'ask');
    assert.throws(() => h.call('configure', {}), { code: 'INVALID_ARGUMENTS' });
});

test('run receipt persists across restart and a lost response retry needs no browser or new task', t => {
    const h = setup(t);
    const first = h.call('run', h.request);
    assert.equal(first.status, 'queued'); assert.deepEqual(h.calls, []);
    h.reload(); h.accounts.modelSource = () => { throw new Error('Browser offline'); };
    const second = h.call('run', { ...h.request, source: { generationId: h.request.source.generationId, accountId: h.request.source.accountId } });
    assert.equal(second.id, first.id); assert.equal(second.reused, true); assert.equal(h.workflow().jobs.length, 1);
    assert.throws(() => h.call('run', { ...h.request, parameters: { targetQuads: 2000 } }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(h.call('history', { projectId: 'project-a' }).jobs[0].id, first.id);
    assert.equal(h.call('history', { projectId: 'project-b' }).total, 0);
    assert.throws(() => h.call('status', { projectId: 'project-b', jobId: first.id }), { code: 'PROJECT_MISMATCH' });
});

test('concurrent source submissions join the active task with independent durable receipts', t => {
    const h = setup(t); const first = h.call('run', h.request);
    const joined = h.call('run', { ...h.request, requestId: 'request-b' });
    assert.equal(joined.id, first.id); assert.equal(joined.reused, true);
    h.reload(); assert.equal(h.call('run', { ...h.request, requestId: 'request-b' }).id, first.id);
    assert.throws(() => h.call('run', { ...h.request, requestId: 'request-c', parameters: { targetQuads: 5000 } }), { code: 'SOURCE_BUSY' });
    h.workflow().jobs[0].status = 'completed'; h.workflow().changed();
    assert.notEqual(h.call('run', { ...h.request, requestId: 'new-execution' }).id, first.id);
});

test('cancel during model download prevents Rhino launch and survives a late completion', async t => {
    const h = setup(t), release = h.holdDownload();
    const job = h.call('run', h.request), pending = h.workflow().drain();
    assert.equal(h.workflow().jobs[0].status, 'downloading');
    assert.equal(h.call('cancel', { projectId: 'project-a', jobId: job.id }).status, 'canceled');
    release(); await pending;
    assert.deepEqual(h.calls, ['download']); assert.equal(h.workflow().jobs[0].status, 'canceled');
    assert.equal(h.call('status', { projectId: 'project-a', jobId: job.id }).canResume, false);
});

test('resume queues the original fixed executor instead of importing or running provider inference', async t => {
    const h = setup(t); const first = h.call('run', h.request), job = h.workflow().jobs[0];
    job.status = 'interrupted'; job.importStarted = true; job.runId = 'agent-fixture';
    h.runtime.runs.set(job.runId, { id: job.runId, status: 'failed' }); h.workflow().changed();
    const resumed = h.call('resume', { projectId: 'project-a', jobId: first.id });
    assert.equal(resumed.id, first.id); assert.equal(resumed.status, 'queued'); assert.deepEqual(h.calls, []);
    await h.workflow().drain(); assert.deepEqual(h.calls, ['resume']); assert.equal(job.status, 'processing');
});

test('unknown mutation blocks resume until the matching completed checkpoint arrives', t => {
    const h = setup(t), first = h.call('run', h.request), job = h.workflow().jobs[0];
    job.status = 'interrupted'; job.runId = 'agent-fixture'; h.runtime.runs.set(job.runId, { id: job.runId, status: 'failed' });
    const directory = path.join(h.directory, 'rhino-model-results', job.id); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'cleanup-dispatch.json'), JSON.stringify({ stage: 'quad', status: 'unknown', invocationId: 'one' }));
    const input = { projectId: 'project-a', jobId: first.id };
    assert.equal(h.call('status', input).canResume, false);
    assert.throws(() => h.call('resume', input), { code: 'RECOVERY_BLOCKED' });
    fs.writeFileSync(path.join(directory, 'cleanup-quad.json'), JSON.stringify({ stage: 'quad', status: 'completed', invocationId: 'one', ok: true, jobId: job.id }));
    assert.equal(h.call('status', input).canResume, true);
    assert.equal(h.call('resume', input).status, 'queued');
});

test('old browser-origin jobs remain discoverable and recoverable through the same workflow catalog', t => {
    const h = setup(t);
    h.workflow().observe(h.request.source.accountId, { worksId: 'old-work', generationId: h.request.source.generationId, status: 'ready' });
    const jobs = h.call('history', { projectId: 'project-a' }).jobs;
    assert.equal(jobs.length, 1); assert.equal(jobs[0].workflowId, h.request.workflowId); assert.equal(jobs[0].version, 1);
});

test('an explicit MCP run can release a browser job whose ready event has not yet arrived in manual mode', t => {
    const h = setup(t);
    h.workflow().configure({ mode: 'ask' });
    h.workflow().observe(h.request.source.accountId, { worksId: 'model-work', generationId: h.request.source.generationId, status: 'generating' });
    const first = h.workflow().jobs[0];
    const result = h.call('run', { ...h.request, parameters: {} });
    assert.equal(result.id, first.id);
    assert.equal(result.status, 'queued');
    assert.equal(first.approved, true);
});

test('automatic model detection joins an MCP job even when its ready event arrives after completion', t => {
    const h = setup(t), first = h.call('run', h.request);
    const task = { worksId: 'model-work', generationId: h.request.source.generationId, status: 'ready' };
    h.workflow().observe(h.request.source.accountId, task);
    assert.equal(h.workflow().jobs.length, 1);
    h.workflow().configure({ mode: 'auto', projectId: 'project-b', conversationId: 'browser-b' });
    h.workflow().observe(h.request.source.accountId, task);
    assert.equal(h.workflow().jobs.length, 1);
    assert.equal(h.workflow().jobs[0].projectId, 'project-a');
    h.workflow().update(h.workflow().jobs[0], 'completed');
    h.workflow().observe(h.request.source.accountId, task);
    assert.equal(h.workflow().jobs.length, 1);
    assert.equal(h.workflow().jobs[0].id, first.id);
});

test('browser import in another project cannot move an MCP job or its receipt', t => {
    const h = setup(t), first = h.call('run', h.request);
    h.workflow().configure({ mode: 'auto', projectId: 'project-b', conversationId: 'browser-b' });
    h.workflow().observe(h.request.source.accountId, { worksId: 'model-work', generationId: h.request.source.generationId,
        status: 'ready', explicitImport: true });
    assert.equal(h.workflow().jobs.length, 2);
    assert.equal(h.call('status', { projectId: 'project-a', jobId: first.id }).projectId, 'project-a');
    assert.equal(h.call('run', h.request).id, first.id);
    assert.equal(h.workflow().jobs[0].conversationId, 'external-workflows');
    assert.equal(h.workflow().jobs[1].projectId, 'project-b');
    assert.notEqual(h.workflow().jobs[1].id, first.id);
});

test('cancel while probing Rhino preserves canceled state and does not start a download', async t => {
    const h = setup(t), first = h.call('run', h.request), job = h.workflow().jobs[0];
    h.workflow().update(job, 'waiting_rhino');
    let release;
    h.rhino.status = () => new Promise(resolve => { release = resolve; });
    const pending = h.workflow().drain();
    h.call('cancel', { projectId: 'project-a', jobId: first.id });
    release({ connected: true }); await pending;
    assert.deepEqual(h.calls, []);
    assert.equal(h.call('status', { projectId: 'project-a', jobId: first.id }).nextAction, 'stopped');
});

test('a failed receipt write cannot acknowledge an unpersisted joined request', t => {
    const h = setup(t), first = h.call('run', h.request), workflow = h.workflow();
    const changed = workflow.changed;
    workflow.changed = () => { throw new Error('disk unavailable'); };
    assert.throws(() => h.call('run', { ...h.request, requestId: 'request-b' }), /disk unavailable/);
    assert.equal(workflow.jobs[0].workflowRequests.length, 1);
    workflow.changed = changed;
    assert.equal(h.call('run', { ...h.request, requestId: 'request-b' }).id, first.id);
    h.reload();
    assert.equal(h.call('run', { ...h.request, requestId: 'request-b' }).id, first.id);
});

test('a repeated failure after resume returns to interrupted instead of leaving the queue processing forever', async t => {
    const h = setup(t), first = h.call('run', h.request), job = h.workflow().jobs[0];
    job.status = 'processing'; job.runId = 'agent-fixture';
    const run = { id: job.runId, status: 'failed' }; h.runtime.runs.set(run.id, run);
    const input = { projectId: 'project-a', jobId: first.id };
    assert.equal(h.call('status', input).status, 'interrupted');
    h.call('resume', input); await h.workflow().drain();
    assert.equal(job.status, 'processing');
    run.status = 'failed';
    const repeated = h.call('status', input);
    assert.equal(repeated.status, 'interrupted');
    assert.equal(repeated.canResume, true);
    assert.equal(repeated.nextAction, 'resume');
});

test('confirmation queues the original manual job, persists approval, and is idempotent', t => {
    const h = setup(t);
    h.workflow().configure({ mode: 'ask' });
    h.workflow().observe(h.request.source.accountId, { worksId: 'old-work', generationId: h.request.source.generationId, status: 'ready' });
    const job = h.workflow().jobs[0], input = { projectId: job.projectId, jobId: job.id };
    const waiting = h.call('status', input);
    assert.equal(waiting.status, 'awaiting_confirmation');
    assert.equal(waiting.nextAction, 'confirm');
    assert.equal(waiting.pollAfterMs, null);
    assert.equal(waiting.canConfirm, true);
    assert.deepEqual(waiting.availableActions, ['confirm', 'cancel']);
    assert.equal(h.call('history', { projectId: job.projectId }).jobs[0].nextAction, 'confirm');
    const confirmed = h.call('confirm', input);
    assert.equal(confirmed.id, job.id);
    assert.equal(confirmed.status, 'queued');
    assert.equal(confirmed.nextAction, 'poll');
    assert.equal(confirmed.reused, false);
    assert.deepEqual(confirmed.availableActions, ['cancel']);
    assert.deepEqual(confirmed.source, waiting.source);
    assert.deepEqual(confirmed.parameters, waiting.parameters);
    assert.equal(h.call('confirm', input).reused, true);
    h.reload();
    assert.equal(h.call('confirm', input).reused, true);
    assert.equal(h.workflow().jobs.length, 1);
    for (const state of ['downloading', 'connecting', 'importing', 'processing', 'completed']) {
        h.workflow().update(h.workflow().jobs[0], state);
        assert.equal(h.call('confirm', input).reused, true);
    }
    assert.deepEqual(h.calls, []);
});

test('waiting Rhino confirmation is project scoped and cannot override immutable workflow parameters', t => {
    const h = setup(t), first = h.call('run', h.request), job = h.workflow().jobs[0];
    h.workflow().update(job, 'waiting_rhino');
    const input = { projectId: job.projectId, jobId: job.id };
    const waiting = h.call('status', input);
    assert.equal(waiting.nextAction, 'poll');
    assert.equal(waiting.pollAfterMs, 3000);
    assert.deepEqual(waiting.availableActions, ['confirm', 'cancel']);
    assert.throws(() => h.call('confirm', { ...input, projectId: 'project-b' }), { code: 'PROJECT_MISMATCH' });
    assert.throws(() => h.call('confirm', { ...input, parameters: { targetQuads: 2000 } }), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => h.call('confirm', { jobId: job.id }), { code: 'INVALID_ARGUMENTS' });
    const confirmed = h.call('confirm', input);
    assert.equal(confirmed.id, first.id);
    assert.equal(confirmed.status, 'queued');
    assert.deepEqual(confirmed.parameters, { targetQuads: 1000 });
});

test('reconfirming an approved importing or processing job returns it without redispatch', t => {
    const h = setup(t), first = h.call('run', h.request), job = h.workflow().jobs[0];
    const input = { projectId: job.projectId, jobId: first.id };
    const writes = [];
    const update = h.workflow().update.bind(h.workflow());
    h.workflow().update = (...args) => { writes.push(args); return update(...args); };
    job.status = 'importing'; job.importStarted = true; job.importInvocationId = 'pending';
    const importing = h.call('confirm', input);
    assert.equal(importing.reused, true);
    assert.equal(importing.status, 'importing');
    assert.equal(importing.nextAction, 'poll');
    job.status = 'processing'; job.runId = 'agent-fixture';
    h.runtime.runs.set(job.runId, { id: job.runId, status: 'running', externalCalls: { cleanup: { readOnly: false, status: 'dispatching' } } });
    const processing = h.call('confirm', input);
    assert.equal(processing.reused, true);
    assert.equal(processing.status, 'processing');
    assert.equal(processing.nextAction, 'poll');
    assert.deepEqual(writes, []);
    assert.deepEqual(h.calls, []);
});

test('confirmation cannot restart interrupted, canceled, or unknown result jobs', t => {
    const h = setup(t), first = h.call('run', h.request), job = h.workflow().jobs[0];
    const input = { projectId: job.projectId, jobId: first.id };
    for (const state of ['interrupted', 'failed', 'canceled', 'generating']) {
        h.workflow().update(job, state);
        assert.throws(() => h.call('confirm', input), { code: 'CONFIRMATION_BLOCKED' });
        assert.equal(job.status, state);
    }
    h.workflow().update(job, 'waiting_rhino', { importStarted: true, importInvocationId: 'missing' });
    const unknown = h.call('status', input);
    assert.equal(unknown.canConfirm, false);
    assert.equal(unknown.nextAction, 'inspect');
    assert.equal(unknown.pollAfterMs, null);
    assert.deepEqual(unknown.availableActions, ['cancel']);
    assert.throws(() => h.call('confirm', input), { code: 'CONFIRMATION_BLOCKED' });
    assert.equal(job.status, 'waiting_rhino');
});

test('failed confirmation persistence does not approve the task in memory', t => {
    const h = setup(t), first = h.call('run', h.request), job = h.workflow().jobs[0];
    h.workflow().update(job, 'awaiting_confirmation', { approved: false });
    h.workflow().changed = () => { throw new Error('disk unavailable'); };
    assert.throws(() => h.call('confirm', { projectId: job.projectId, jobId: first.id }), /disk unavailable/);
    assert.equal(job.status, 'awaiting_confirmation');
    assert.equal(job.approved, false);
});

test('status and history identify a cross-project interrupted blocker and cancel releases the queue', async t => {
    const h = setup(t), first = h.call('run', h.request), blocker = h.workflow().jobs[0];
    h.workflow().update(blocker, 'interrupted');
    const second = h.call('run', { ...h.request, projectId: 'project-b', requestId: 'request-b' });
    const input = { projectId: 'project-b', jobId: second.id };
    const blocked = h.call('status', input);
    assert.deepEqual(blocked.blockedBy, { jobId: first.id, projectId: 'project-a', status: 'interrupted' });
    assert.equal(blocked.nextAction, 'resolve_blocker');
    assert.equal(blocked.pollAfterMs, null);
    assert.deepEqual(blocked.availableActions, ['cancel']);
    assert.deepEqual(h.call('history', { projectId: 'project-b' }).jobs[0].blockedBy, blocked.blockedBy);
    assert.deepEqual(h.call('status', { projectId: 'project-a', jobId: first.id }).availableActions, ['resume', 'cancel']);
    await h.workflow().drain();
    assert.deepEqual(h.calls, []);
    assert.equal(h.call('cancel', { projectId: 'project-a', jobId: first.id }).nextAction, 'stopped');
    const unblocked = h.call('status', input);
    assert.equal(unblocked.blockedBy, null);
    assert.equal(unblocked.nextAction, 'poll');
    await h.workflow().drain();
    assert.deepEqual(h.calls, ['download', 'open']);
});
