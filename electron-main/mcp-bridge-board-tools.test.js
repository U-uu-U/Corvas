const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const FlowCanvasBridge = require('./mcp-bridge');
const { DEFAULT_MCP_CONFIG } = require('../shared/plan-service-core.cjs');
const { WORKFLOW_TOOL_DEFINITIONS } = require('../shared/workflow-tools.cjs');
const { HANDOFF_TOOL_DEFINITIONS } = require('../shared/handoff-tools.cjs');

function createBridge(options = {}) {
    const requests = [];
    const webContents = {
        isDestroyed: () => false,
        send: (_channel, payload) => requests.push(payload)
    };
    const mainWindow = {
        isDestroyed: () => false,
        webContents
    };
    const bridge = new FlowCanvasBridge({
        store: {
            load: () => ({ folderGroups: [], mcp: {} }),
            save: () => true
        },
        getMainWindow: () => mainWindow,
        boardToolRequestTimeoutMs: options.timeoutMs || 100
    });
    return { bridge, requests };
}

function nextTurn() {
    return new Promise(resolve => setImmediate(resolve));
}

test('board tool requests require a ready renderer and preserve structured errors', async () => {
    const { bridge, requests } = createBridge();
    await assert.rejects(
        bridge._requestBoardTool('flow_canvas.board.get_snapshot', {}),
        error => error.code === 'RENDERER_NOT_READY' && error.status === 503
    );

    bridge.setBoardToolsReady(true);
    const pending = bridge._requestBoardTool('flow_canvas.board.get_snapshot', { scope: 'selection' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].toolName, 'flow_canvas.board.get_snapshot');
    bridge.handleBoardToolResponse({
        requestId: requests[0].requestId,
        success: false,
        error: {
            code: 'REVISION_CONFLICT',
            message: 'revision changed',
            details: { expectedRevision: 3, actualRevision: 4 }
        }
    });
    await assert.rejects(
        pending,
        error => error.code === 'REVISION_CONFLICT'
            && error.status === 409
            && error.details.actualRevision === 4
    );
});

test('renderer refresh rejects pending requests and late responses are ignored', async () => {
    const { bridge, requests } = createBridge();
    bridge.setBoardToolsReady(true);
    const pending = bridge._requestBoardTool('flow_canvas.board.transaction.preview', { id: 'tx' });
    bridge.setBoardToolsReady(false, {
        code: 'RENDERER_RELOADING',
        message: 'renderer reloading'
    });
    await assert.rejects(pending, error => error.code === 'RENDERER_RELOADING');
    assert.equal(bridge.handleBoardToolResponse({
        requestId: requests[0].requestId,
        success: true,
        result: {}
    }), false);
});

test('board tool request timeout clears the pending request', async t => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const { bridge } = createBridge({ timeoutMs: 20 });
    bridge.setBoardToolsReady(true);
    await assert.rejects(
        bridge._requestBoardTool('flow_canvas.board.get_snapshot', {}),
        error => error.code === 'BOARD_TOOL_TIMEOUT' && error.status === 504
    );
    assert.equal(bridge.pendingBoardToolRequests.size, 0);
});

test('generation cancellation aborts active work and catches pre-registration races', async () => {
    const { bridge } = createBridge();
    let releaseActive;
    const active = bridge._runCancelableGeneration('task-active', signal => new Promise(resolve => {
        releaseActive = resolve;
        signal.addEventListener('abort', () => resolve('late result'), { once: true });
    }));
    await nextTurn();
    assert.deepEqual(bridge.cancelGenerationFromRenderer('task-active'), {
        canceled: true,
        active: true
    });
    await assert.rejects(active, error => error.code === 'GENERATION_CANCELED');
    releaseActive?.('unused');

    assert.deepEqual(bridge.cancelGenerationFromRenderer('task-before-start'), {
        canceled: true,
        active: false
    });
    await assert.rejects(
        bridge._runCancelableGeneration('task-before-start', async () => 'should not run'),
        error => error.code === 'GENERATION_CANCELED'
    );
});

test('missing local image references block an external edit before the API request', async () => {
    const { bridge } = createBridge();
    const missingPath = path.join(os.tmpdir(), `flow-canvas-missing-${Date.now()}.png`);
    await assert.rejects(
        bridge._generateImageFromRenderer({
            prompt: 'edit the reference image',
            provider: 'openai',
            providerConfig: {
                apiKey: 'test-key',
                endpoint: 'https://example.invalid/v1/images/generations',
                model: 'gpt-image-1'
            },
            sourceReferences: [{ filePath: missingPath, name: 'missing-reference.png' }],
            targetDir: os.tmpdir()
        }),
        error => /参考图文件不存在或无法读取/.test(error.message)
            && /重新选择参考图/.test(error.message)
    );
});

test('apply and undo routes are serialized through the mutation queue', async () => {
    const { bridge, requests } = createBridge();
    bridge.setBoardToolsReady(true);
    const route = bridge._matchRoute('POST', '/board/transactions/apply');
    const first = route.handler({}, { id: 'tx-1' });
    const second = route.handler({}, { id: 'tx-2' });

    await nextTurn();
    assert.deepEqual(requests.map(request => request.input.id), ['tx-1']);
    bridge.handleBoardToolResponse({
        requestId: requests[0].requestId,
        success: true,
        result: { transactionId: 'tx-1' }
    });

    await nextTurn();
    assert.deepEqual(requests.map(request => request.input.id), ['tx-1', 'tx-2']);
    bridge.handleBoardToolResponse({
        requestId: requests[1].requestId,
        success: true,
        result: { transactionId: 'tx-2' }
    });
    assert.deepEqual(await Promise.all([first, second]), [
        { transactionId: 'tx-1' },
        { transactionId: 'tx-2' }
    ]);
});

test('HTTP bridge returns 403 when a board tool is not allowed', async () => {
    const port = await getFreePort();
    const { bridge } = createBridge();
    bridge.start({ enabled: true, host: '127.0.0.1', port, allowedTools: [] });
    await waitForListening(bridge.server);
    try {
        const response = await fetch(`http://127.0.0.1:${port}/board/snapshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const payload = await response.json();
        assert.equal(response.status, 403);
        assert.match(payload.error, /not allowed/);
    } finally {
        bridge.stop();
    }
});

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

test('handoff routes use their own executor and cannot be called through Agent routes', async () => {
    const { bridge, requests } = createBridge();
    const calls = [];
    bridge.handoffExecutor = async (name, input) => { calls.push({ name, input }); return { id: 'fixture' }; };
    bridge.agentExecutor = () => { throw new Error('Internal Agent must not run'); };
    for (const tool of HANDOFF_TOOL_DEFINITIONS) {
        const route = bridge._matchRoute('POST', `/handoff/tools/${tool.name}`);
        assert.equal(route.toolName, tool.name);
        assert.deepEqual(await route.handler({}, { projectId: 'project' }), { result: { id: 'fixture' } });
        assert.equal(bridge._matchRoute('POST', `/agent/tools/${tool.name}`), null);
    }
    assert.equal(calls.length, HANDOFF_TOOL_DEFINITIONS.length);
    assert.deepEqual(requests, []);
    assert.equal(bridge._matchRoute('POST', '/handoff/tools/flow_canvas.agent.start'), null);
});

test('disabled external handoff tools never dispatch', async () => {
    const { bridge } = createBridge();
    const port = await getFreePort();
    let dispatched = false;
    bridge.handoffExecutor = () => { dispatched = true; };
    bridge.start({ ...DEFAULT_MCP_CONFIG, port,
        allowedTools: DEFAULT_MCP_CONFIG.allowedTools.filter(name => name !== 'flow_canvas.handoff.call') });
    await nextTurn();
    try {
        const response = await fetch(`http://127.0.0.1:${port}/handoff/tools/flow_canvas.handoff.call`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 403);
        assert.equal(dispatched, false);
    } finally { bridge.stop(); }
});

test('external outputs import into their original project after the visible project changes', async t => {
    const fs = require('node:fs');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-handoff-output-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'result.obj');
    fs.writeFileSync(filePath, 'v 0 0 0');
    const data = { activeGroupId: 'other', items: [], connections: [], folderGroups: [
        { id: 'original', savedItems: [], connections: [], plans: [], boardRevision: 0 },
        { id: 'other', savedItems: [], connections: [], plans: [], boardRevision: 0 }
    ] };
    const { AgentBoardService } = await import('./agent-board-service.mjs');
    let current = structuredClone(data);
    const board = new AgentBoardService({ store: { load: () => current, save: value => { current = value; return true; } } });
    const { bridge } = createBridge();
    bridge.projectItemAdder = async (projectId, add) => (await board.updateProject(projectId, add)).value;
    const first = await bridge._addItem({ projectId: 'original', filePath });
    const second = await bridge._addItem({ projectId: 'original', filePath });
    assert.equal(first.item.id, second.item.id);
    assert.equal(board.readProject('original').items.length, 1);
    assert.equal(board.readProject('other').items.length, 0);
    assert.equal(current.activeGroupId, 'other');
    await assert.rejects(bridge._addItem({ projectId: 'deleted', filePath }), /Project not found/);
});

test('workflow routes execute independently of the Agent and renderer', async () => {
    const { bridge, requests } = createBridge();
    const executions = [];
    bridge.agentExecutor = () => { throw new Error('The Agent must not run'); };
    bridge.workflowExecutor = async (toolName, body) => {
        executions.push({ toolName, body });
        return { jobId: 'a'.repeat(32), status: 'queued' };
    };
    for (const tool of WORKFLOW_TOOL_DEFINITIONS) {
        const route = bridge._matchRoute('POST', `/workflow/tools/${tool.name}`);
        assert.equal(route.toolName, tool.name);
        const body = { projectId: null, jobId: 'a'.repeat(32) };
        assert.deepEqual(await route.handler({}, body), { result: { jobId: 'a'.repeat(32), status: 'queued' } });
        assert.deepEqual(executions.at(-1), { toolName: tool.name, body });
        assert.equal(bridge._matchRoute('POST', `/agent/tools/${tool.name}`), null);
    }
    assert.equal(requests.length, 0);
    assert.equal(bridge._matchRoute('POST', '/workflow/tools/flow_canvas.agent.start'), null);
    assert.equal(bridge._matchRoute('POST', '/agent/tools/flow_canvas.rhino.cleanup'), null);
    assert.equal(bridge._matchRoute('POST', '/workflow/tools/flow_canvas.workflow.unknown'), null);
});

test('workflow HTTP errors preserve status, code, and recovery details', async () => {
    const port = await getFreePort();
    const { bridge } = createBridge();
    bridge.start({ enabled: true, host: '127.0.0.1', port });
    await waitForListening(bridge.server);
    const call = () => fetch(`http://127.0.0.1:${port}/workflow/tools/flow_canvas.workflow.resume`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: null, jobId: 'a'.repeat(32) })
    });
    try {
        const unavailable = await call();
        assert.equal(unavailable.status, 503);
        assert.equal((await unavailable.json()).code, 'TOOL_UNAVAILABLE');
        bridge.workflowExecutor = async () => {
            throw Object.assign(new Error('Request inputs changed'), {
                status: 409, code: 'WORKFLOW_CONFLICT', details: { jobId: 'a'.repeat(32), recovery: 'Read status' }
            });
        };
        const failed = await call();
        assert.equal(failed.status, 409);
        assert.deepEqual(await failed.json(), { success: false, error: 'Request inputs changed',
            code: 'WORKFLOW_CONFLICT', details: { jobId: 'a'.repeat(32), recovery: 'Read status' } });
    } finally {
        bridge.stop();
    }
});

test('workflow HTTP allowlist rejects disabled tools without restoring legacy defaults', async () => {
    const port = await getFreePort();
    const { bridge } = createBridge();
    let executions = 0;
    bridge.workflowExecutor = async () => { executions++; };
    bridge.start({ enabled: true, host: '127.0.0.1', port,
        allowedTools: DEFAULT_MCP_CONFIG.allowedTools.filter(name => name !== 'flow_canvas.workflow.run') });
    await waitForListening(bridge.server);
    try {
        const response = await fetch(`http://127.0.0.1:${port}/workflow/tools/flow_canvas.workflow.run`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        assert.equal(response.status, 403);
        assert.match((await response.json()).error, /not allowed/);
        assert.equal(executions, 0);
    } finally {
        bridge.stop();
    }
});

function waitForListening(server) {
    if (server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
}
