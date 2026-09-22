const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Ajv = require('ajv');
const { ExternalHandoffService } = require('./external-handoff.cjs');
const { toolId } = require('./mcp-client.cjs');
const { HANDOFF_TOOL_DEFINITIONS } = require('../shared/handoff-tools.cjs');
const copy = value => JSON.parse(JSON.stringify(value));

function harness(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'external-handoff-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const modelPath = path.join(directory, 'original.glb');
    fs.writeFileSync(modelPath, 'original');
    const projects = new Map([
        ['p', { revision: 8, items: [{ id: 'model', kind: 'media', mediaType: 'model', title: 'Original', filePath: modelPath }] }],
        ['q', { revision: 3, items: [{ id: 'other', kind: 'text', text: 'Other project' }] }],
        [null, { revision: 0, items: [] }]
    ]);
    const board = { readProject(id) { if (!projects.has(id)) throw new Error('Project not found'); return copy(projects.get(id)); } };
    const shape = { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false };
    const servers = [
        { id: 'b', name: 'Blender', enabled: true, status: 'connected', env: { TOKEN: 'hidden-token' }, headers: { Authorization: 'hidden-token' },
            command: 'private-command', args: ['private-args'], url: 'https://private.invalid', tools: [
                { name: 'run_code', description: 'Execute Blender code', inputSchema: shape, readOnly: false },
                { name: 'inspect_scene', description: 'Inspect Blender scene', inputSchema: { type: 'object' }, readOnly: true }
            ] },
        { id: 'r', name: 'Cordyceps', enabled: true, status: 'disconnected', tools: [{ name: 'rhino_scene', inputSchema: shape, readOnly: true }] },
        { id: 'x', name: 'Private database', enabled: true, status: 'connected', tools: [{ name: 'query', inputSchema: shape, readOnly: false }] },
        { id: 'off', name: 'Blender disabled', enabled: false, status: 'disconnected', tools: [] }
    ];
    const bindings = new Map(servers.flatMap(server => server.tools.map(tool => [toolId(server.id, tool.name), `binding-${server.id}-${tool.name}`])));
    const calls = [], connects = [], changes = [];
    const client = {
        list: () => ({ servers: copy(servers) }),
        secrets: () => ['hidden-token'],
        redact: value => String(value).replaceAll('hidden-token', '[redacted]').slice(0, 2000),
        binding: name => bindings.get(name),
        isReadOnly: name => servers.some(server => server.tools.some(tool => toolId(server.id, tool.name) === name && tool.readOnly)),
        async connect(id) { connects.push(id); servers.find(server => server.id === id).status = 'connected'; },
        async call(name, args, options) {
            const tool = servers.flatMap(server => server.tools.map(tool => ({ ...tool, localName: toolId(server.id, tool.name) }))).find(tool => tool.localName === name);
            if (!new Ajv().validate(tool.inputSchema, args)) throw new Error('Invalid arguments');
            await client.beforeDispatch?.();
            options.onDispatch(); calls.push({ name, args: copy(args) });
            return client.result ? client.result(name, args) : { content: [{ type: 'text', text: 'done hidden-token' }] };
        }
    };
    const make = () => new ExternalHandoffService({ directory, board, mcpClient: client, onChange: event => changes.push(event) });
    const service = make();
    const create = (overrides = {}) => service.create({ projectId: 'p', target: 'blender', instruction: 'Inspect and prepare model', referenceNodeIds: ['model'], requestId: 'task-request', ...overrides });
    const claim = (task, overrides = {}) => service.claim({ projectId: task.projectId, taskId: task.id, clientId: 'codex-client', ...overrides });
    const callInput = (task, overrides = {}) => ({ projectId: task.projectId, taskId: task.id, clientId: 'codex-client', serverId: 'b', toolName: 'run_code',
        binding: bindings.get(toolId('b', 'run_code')), requestId: 'operation-1', arguments: { code: 'model.prepare()' }, ...overrides });
    return { directory, service, projects, modelPath, client, servers, bindings, calls, connects, changes, make, create, claim, callInput };
}

test('persists original material identity, detects source changes, and isolates projects', t => {
    const h = harness(t);
    const task = h.create();
    assert.equal(task.status, 'queued');
    assert.equal(task.references[0].filePath, h.modelPath);
    assert.deepEqual(task.referenceIssues, []);
    assert.equal(h.create().id, task.id);
    assert.throws(() => h.create({ instruction: 'Different task' }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.throws(() => h.create({ referenceNodeIds: ['other'] }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.throws(() => h.create({ requestId: 'foreign', referenceNodeIds: ['other'] }), { code: 'REFERENCE_NOT_FOUND' });
    assert.deepEqual(h.service.list({ projectId: 'q' }), { tasks: [] });
    assert.throws(() => h.service.get({ projectId: 'q', taskId: task.id }), { code: 'TASK_NOT_FOUND' });
    assert.equal(h.create({ projectId: null, referenceNodeIds: [] }).projectId, null);
    h.projects.get('p').items[0].title = 'Renamed';
    let current = h.make().get({ projectId: 'p', taskId: task.id });
    assert.equal(current.references[0].title, 'Original');
    assert.equal(current.referenceIssues[0].type, 'changed');
    fs.unlinkSync(h.modelPath);
    assert.equal(h.service.get({ projectId: 'p', taskId: task.id }).referenceIssues[0].type, 'missing_file');
    h.projects.get('p').items = [];
    current = h.service.get({ projectId: 'p', taskId: task.id });
    assert.equal(current.referenceIssues[0].type, 'missing_node');
    assert.equal(h.create().id, task.id, 'retries preserve the original request even after source removal');
});

test('claims validate conversation URLs, enforce owner, and only attach original-project results', t => {
    const h = harness(t), task = h.create();
    const base = { projectId: 'p', taskId: task.id, clientId: 'codex-client' };
    assert.throws(() => h.service.update({ ...base, status: 'running' }), { code: 'OWNER_MISMATCH' });
    assert.throws(() => h.claim(task, { conversationUrl: 'https://evil.invalid' }), { code: 'INVALID_ARGUMENTS' });
    const claimed = h.claim(task, { conversationUrl: 'codex://threads/019e96d7-2695-7611-a3e7-a457304c4db5' });
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.owner.clientId, 'codex-client');
    assert.throws(() => h.claim(task, { clientId: 'other-client' }), { code: 'OWNER_MISMATCH' });
    assert.throws(() => h.service.update({ ...base, status: 'completed', resultNodeIds: ['other'] }), { code: 'RESULT_NOT_FOUND' });
    h.projects.get('p').items.push({ id: 'output', kind: 'media', filePath: h.modelPath });
    assert.equal(h.service.update({ ...base, status: 'awaiting_user', summary: 'Need a decision' }).status, 'awaiting_user');
    const completed = h.service.update({ ...base, status: 'completed', resultNodeIds: ['output'], summary: 'Imported output' });
    assert.deepEqual(completed.resultNodeIds, ['output']);
    assert.ok(completed.finishedAt);
    assert.throws(() => h.service.update({ ...base, status: 'running' }), { code: 'TASK_FINISHED' });
});

test('discovery returns real schemas with no MCP configuration and connects only target servers', async t => {
    const h = harness(t), task = h.create({ target: 'rhino' });
    const found = await h.service.tools({ projectId: 'p', taskId: task.id });
    assert.deepEqual(h.connects, ['r']);
    assert.deepEqual(found.servers, [{ id: 'r', name: 'Cordyceps', status: 'connected' }]);
    assert.equal(found.tools[0].name, 'rhino_scene');
    assert.deepEqual(found.tools[0].inputSchema, h.servers[1].tools[0].inputSchema);
    assert.equal(found.tools[0].binding, h.bindings.get(toolId('r', 'rhino_scene')));
    assert.doesNotMatch(JSON.stringify(found), /hidden-token|headers|private-command|private-args|private.invalid/);
    assert.equal(HANDOFF_TOOL_DEFINITIONS.length, 6);
    assert.throws(() => h.service.execute('flow_canvas.handoff.create', {}), { code: 'TOOL_NOT_FOUND' });
    assert.throws(() => h.service.execute('flow_canvas.handoff.list', {}), { code: 'INVALID_ARGUMENTS' });
});

test('calls use durable idempotency and preserve MCP images without model inference', async t => {
    const h = harness(t), task = h.create(); h.claim(task);
    const image = { type: 'image', mimeType: 'image/png', data: Buffer.alloc(3000).toString('base64') };
    h.client.result = () => ({ content: [{ type: 'text', text: `Model state hidden-token ${'a'.repeat(3000)}` }, image] });
    const input = h.callInput(task, { arguments: { code: 'hidden-token' } });
    const result = await h.service.call(input);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result.content[1], image);
    assert.ok(result.result.content[0].text.length > 3000);
    assert.doesNotMatch(result.result.content[0].text, /hidden-token/);
    assert.deepEqual(h.calls[0].args, { code: 'hidden-token' });
    const retry = await h.make().call(input);
    assert.equal(retry.reused, true);
    assert.deepEqual(retry.result, result.result);
    assert.equal(h.calls.length, 1);
    assert.equal(h.service.list({ projectId: 'p' }).tasks[0].calls[0].result, undefined);
    await assert.rejects(h.service.call({ ...input, arguments: { code: 'different' } }), { code: 'IDEMPOTENCY_CONFLICT' });
    const disk = fs.readFileSync(h.service.file, 'utf8');
    assert.doesNotMatch(disk, /hidden-token/);
    assert.equal(JSON.parse(disk).tasks[0].calls[0].arguments, undefined);
});

test('unknown writes never replay and require an inspected resolution before more writes', async t => {
    const h = harness(t), task = h.create(); h.claim(task);
    h.client.result = () => { throw Object.assign(new Error('timeout hidden-token'), { code: 'MCP_RESULT_UNKNOWN' }); };
    const input = h.callInput(task);
    assert.equal((await h.service.call(input)).status, 'unknown');
    assert.equal((await h.service.call(input)).reused, true);
    assert.equal(h.calls.length, 1);
    await assert.rejects(h.service.call({ ...input, requestId: 'write-2' }), { code: 'CALL_UNRESOLVED' });
    assert.throws(() => h.service.update({ projectId: 'p', taskId: task.id, clientId: 'codex-client', status: 'completed' }), { code: 'CALL_UNRESOLVED' });
    h.client.result = () => ({ content: [{ type: 'text', text: 'Object exists, geometry valid' }] });
    const inspection = await h.service.call(h.callInput(task, { toolName: 'inspect_scene', binding: h.bindings.get(toolId('b', 'inspect_scene')), arguments: {}, requestId: 'inspect' }));
    assert.equal(inspection.status, 'completed');
    const resolved = h.service.update({ projectId: 'p', taskId: task.id, clientId: 'codex-client', resolvedCalls: [
        { requestId: input.requestId, status: 'completed', summary: 'inspect_scene found the prepared object and validated its geometry' }
    ] });
    assert.equal(resolved.calls[0].status, 'completed');
    assert.equal((await h.service.call({ ...input, requestId: 'write-2' })).status, 'completed');
    assert.equal(h.calls.length, 3);
});

test('an in-flight write blocks other writes and cannot be marked resolved', async t => {
    const h = harness(t), task = h.create(); h.claim(task);
    let finish;
    h.client.result = () => new Promise(resolve => { finish = resolve; });
    const pending = h.service.call(h.callInput(task));
    await new Promise(resolve => setImmediate(resolve));
    const repeated = await h.service.call(h.callInput(task));
    assert.equal(repeated.status, 'dispatching');
    await assert.rejects(h.service.call(h.callInput(task, { requestId: 'parallel' })), { code: 'CALL_UNRESOLVED' });
    assert.throws(() => h.service.update({ projectId: 'p', taskId: task.id, clientId: 'codex-client', resolvedCalls: [
        { requestId: 'operation-1', status: 'completed', summary: 'Not yet observable' }
    ] }), { code: 'INVALID_RESOLUTION' });
    h.service.cancel({ projectId: 'p', taskId: task.id });
    finish({ content: [{ type: 'text', text: 'already dispatched work finished' }] });
    assert.equal((await pending).status, 'completed');
    assert.equal(h.service.get({ projectId: 'p', taskId: task.id }).status, 'canceled');
    assert.equal((await h.service.call(h.callInput(task))).reused, true);
});

test('restart turns dispatching receipts unknown and never replays either old receipt', async t => {
    const h = harness(t), task = h.create(); h.claim(task);
    await h.service.call(h.callInput(task));
    const saved = JSON.parse(fs.readFileSync(h.service.file, 'utf8'));
    saved.tasks[0].calls[0].status = 'dispatching';
    saved.tasks[0].calls.push({ ...saved.tasks[0].calls[0], requestId: 'queued', status: 'pending' });
    fs.writeFileSync(h.service.file, JSON.stringify(saved));
    const restarted = h.make();
    const receipts = restarted.get({ projectId: 'p', taskId: task.id }).calls;
    assert.equal(receipts[0].status, 'unknown');
    assert.equal(receipts[1].status, 'failed');
    assert.equal((await restarted.call(h.callInput(task))).status, 'unknown');
    assert.equal((await restarted.call(h.callInput(task, { requestId: 'queued' }))).status, 'failed');
    assert.equal(h.calls.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(h.service.file, 'utf8')).tasks[0].calls[0].status, 'unknown');
});

test('connection binding changes and foreign-server calls are rejected before dispatch', async t => {
    const h = harness(t), task = h.create(); h.claim(task);
    await assert.rejects(h.service.call(h.callInput(task, { serverId: 'x', toolName: 'query', binding: h.bindings.get(toolId('x', 'query')) })), { code: 'TOOL_CHANGED' });
    await assert.rejects(h.service.call(h.callInput(task, { binding: 'old-binding' })), { code: 'TOOL_CHANGED' });
    h.client.beforeDispatch = () => { h.bindings.set(toolId('b', 'run_code'), 'new-binding'); };
    const result = await h.service.call(h.callInput(task));
    assert.equal(result.status, 'failed');
    assert.equal(h.calls.length, 0);
    assert.equal(h.service.get({ projectId: 'p', taskId: task.id }).calls[0].dispatchedAt, undefined);
});

test('invalid tool arguments fail before dispatch and remain idempotent', async t => {
    const h = harness(t), task = h.create(); h.claim(task);
    const input = h.callInput(task, { arguments: { unknown: true } });
    assert.equal((await h.service.call(input)).status, 'failed');
    assert.equal(h.calls.length, 0);
    assert.equal((await h.service.call(input)).reused, true);
    assert.throws(() => h.create({ requestId: 'large', referenceNodeIds: Array.from({ length: 21 }, (_, i) => `n-${i}`) }), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => h.create({ requestId: 'extra', execution: 'rhino_cleanup' }), { code: 'INVALID_ARGUMENTS' });
});

test('corrupt storage is preserved and blocks all mutations', t => {
    const h = harness(t);
    fs.writeFileSync(h.service.file, '{corrupt');
    const broken = h.make();
    assert.ok(broken.loadError);
    assert.throws(() => broken.create({ projectId: 'p', target: 'blender', instruction: 'Task', referenceNodeIds: [], requestId: 'r' }), { code: 'HANDOFF_UNAVAILABLE' });
    assert.equal(fs.readFileSync(h.service.file, 'utf8'), '{corrupt');
    assert.throws(() => broken.list({ projectId: 'p' }), { code: 'HANDOFF_UNAVAILABLE' });
});

test('checkpoint write failure prevents dispatch; result persistence failure stays unknown', async t => {
    const h = harness(t), task = h.create(); h.claim(task);
    const persist = h.service.persist.bind(h.service);
    let failStatus = 'dispatching';
    h.service.persist = () => {
        if (h.service.tasks[0].calls.some(call => call.status === failStatus)) {
            failStatus = '';
            throw new Error('Disk write failed');
        }
        return persist();
    };
    assert.equal((await h.service.call(h.callInput(task))).status, 'failed');
    assert.equal(h.calls.length, 0);
    failStatus = 'completed';
    const input = h.callInput(task, { requestId: 'result-save' });
    assert.equal((await h.service.call(input)).status, 'unknown');
    assert.equal(h.calls.length, 1);
    assert.equal(h.service.get({ projectId: 'p', taskId: task.id }).calls[1].status, 'unknown');
    assert.equal((await h.make().call(input)).status, 'unknown');
    assert.equal(h.calls.length, 1);
});

test('canceled or closed tasks do not dispatch queued commands', async t => {
    const h = harness(t), task = h.create(); h.claim(task);
    h.client.beforeDispatch = () => h.service.cancel({ projectId: 'p', taskId: task.id });
    assert.equal((await h.service.call(h.callInput(task))).status, 'failed');
    assert.equal(h.calls.length, 0);
    const another = h.create({ requestId: 'another' }); h.claim(another);
    h.client.beforeDispatch = () => h.service.close();
    assert.equal((await h.service.call(h.callInput(another))).status, 'failed');
    assert.equal(h.calls.length, 0);
});

test('unknown writes lock the same connection across tasks and projects while reads remain usable', async t => {
    const h = harness(t), task = h.create(); h.claim(task);
    h.client.result = () => { throw new Error('Remote connection interrupted'); };
    assert.equal((await h.service.call(h.callInput(task))).status, 'unknown');
    const sameProject = h.create({ requestId: 'same-project' }); h.claim(sameProject);
    const otherProject = h.create({ projectId: 'q', referenceNodeIds: [], requestId: 'other-project' }); h.claim(otherProject);
    const blocking = { taskId: task.id, projectId: 'p', requestId: 'operation-1' };
    for (const next of [sameProject, otherProject]) {
        await assert.rejects(h.service.call(h.callInput(next)), error => {
            assert.equal(error.code, 'CALL_UNRESOLVED');
            assert.deepEqual(error.details.blocking, blocking);
            return true;
        });
    }
    h.client.result = () => ({ content: [{ type: 'text', text: 'Scene read succeeded' }] });
    assert.equal((await h.service.call(h.callInput(otherProject, { toolName: 'inspect_scene', binding: h.bindings.get(toolId('b', 'inspect_scene')), arguments: {}, requestId: 'inspect' }))).status, 'completed');
    assert.equal(h.calls.length, 2);
});

test('queued writes recheck other tasks at dispatch after an earlier result becomes unknown', async t => {
    const h = harness(t), first = h.create(); h.claim(first);
    const second = h.create({ requestId: 'second' }); h.claim(second);
    let finishFirst, releaseSecond, beforeCount = 0;
    h.client.beforeDispatch = () => ++beforeCount === 2 ? new Promise(resolve => { releaseSecond = resolve; }) : undefined;
    h.client.result = () => new Promise((_, reject) => { finishFirst = reject; });
    const firstCall = h.service.call(h.callInput(first));
    await new Promise(resolve => setImmediate(resolve));
    const secondCall = h.service.call(h.callInput(second));
    await new Promise(resolve => setImmediate(resolve));
    finishFirst(new Error('Timed out after dispatch'));
    assert.equal((await firstCall).status, 'unknown');
    releaseSecond();
    const result = await secondCall;
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.blocking, { taskId: first.id, projectId: 'p', requestId: 'operation-1' });
    assert.equal(h.calls.length, 1);
});

test('canceled and failed tasks can resolve unknown calls without reopening or replacing results', async t => {
    const h = harness(t);
    for (const status of ['canceled', 'failed']) {
        const task = h.create({ requestId: status }); h.claim(task);
        const base = { projectId: 'p', taskId: task.id, clientId: 'codex-client' };
        h.client.result = () => { throw new Error('Unknown remote outcome'); };
        assert.equal((await h.service.call(h.callInput(task))).status, 'unknown');
        const finished = h.service.update({ ...base, status });
        const next = h.create({ requestId: `${status}-next` }); h.claim(next);
        await assert.rejects(h.service.call(h.callInput(next)), { code: 'CALL_UNRESOLVED' });
        assert.throws(() => h.service.update({ ...base, status: 'running' }), { code: 'TASK_FINISHED' });
        assert.throws(() => h.service.update({ ...base, resultNodeIds: [], summary: 'Attempt to replace results' }), { code: 'TASK_FINISHED' });
        h.client.result = () => ({ content: [{ type: 'text', text: 'Scene confirms completed mutation' }] });
        assert.equal((await h.service.call(h.callInput(task, { toolName: 'inspect_scene', binding: h.bindings.get(toolId('b', 'inspect_scene')), arguments: {}, requestId: 'inspect' }))).status, 'completed');
        const resolved = h.service.update({ ...base, summary: 'Inspected finished task', resolvedCalls: [
            { requestId: 'operation-1', status: 'completed', summary: 'Scene query confirms completed mutation' }
        ] });
        assert.equal(resolved.status, status);
        assert.equal(resolved.finishedAt, finished.finishedAt);
        assert.equal((await h.service.call(h.callInput(next))).status, 'completed');
    }
});
