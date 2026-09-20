const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Ajv = require('ajv');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { WORKFLOW_TOOL_DEFINITIONS, HUNYUAN_RHINO_WORKFLOW } = require('../shared/workflow-tools.cjs');

test('stdio MCP exposes and calls the shared board transaction tools', async (t) => {
    const bridgeRequests = [];
    const bridge = http.createServer(async (req, res) => {
        const body = await readJson(req);
        bridgeRequests.push({ method: req.method, path: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            snapshot: {
                schema: 'flow-canvas.board-snapshot.v1',
                revision: 7,
                scope: body.scope
            }
        }));
    });
    await listen(bridge);
    t.after(() => closeServer(bridge));

    const address = bridge.address();
    const child = spawn(process.execPath, [path.join(__dirname, 'flow-canvas-mcp.mjs')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            FLOW_CANVAS_BRIDGE_URL: `http://127.0.0.1:${address.port}`
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    const client = createMcpClient(child);
    t.after(() => {
        child.stdin.end();
        if (!child.killed) child.kill();
    });

    const initialized = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'flow-canvas-test-harness', version: '1.0.0' }
    });
    assert.equal(initialized.result.serverInfo.name, 'flow-canvas-mcp');

    const listed = await client.request('tools/list', {});
    const names = listed.result.tools.map(tool => tool.name);
    assert.ok(names.includes('flow_canvas.board.get_snapshot'));
    assert.ok(names.includes('flow_canvas.board.transaction.preview'));
    assert.ok(names.includes('flow_canvas.board.transaction.apply'));
    assert.ok(names.includes('flow_canvas.board.transaction.undo'));
    assert.equal(names.includes('flow_canvas.rhino.cleanup'), false);

    const called = await client.request('tools/call', {
        name: 'flow_canvas.board.get_snapshot',
        arguments: { scope: 'project' }
    });
    const result = JSON.parse(called.result.content[0].text);
    assert.equal(result.snapshot.revision, 7);
    assert.deepEqual(bridgeRequests, [{
        method: 'POST',
        path: '/board/snapshot',
        body: { scope: 'project' }
    }]);
});

test('workflow schemas require scoped IDs and reject unsupported inputs', () => {
    const validator = new Ajv({ allErrors: true });
    const validators = Object.fromEntries(WORKFLOW_TOOL_DEFINITIONS.map(tool => [
        tool.name.replace('flow_canvas.workflow.', ''), validator.compile(tool.inputSchema)
    ]));
    const run = {
        workflowId: HUNYUAN_RHINO_WORKFLOW.id,
        version: 1,
        projectId: null,
        requestId: 'request-1',
        source: { accountId: 'account-1', generationId: 'a'.repeat(32) }
    };
    assert.equal(validators.run(run), true);
    assert.equal(validators.run({ ...run, parameters: { targetQuads: 80000 } }), true);
    for (const key of ['workflowId', 'version', 'projectId', 'requestId', 'source']) {
        const input = { ...run };
        delete input[key];
        assert.equal(validators.run(input), false, `Missing ${key} must be rejected`);
    }
    for (const patch of [
        { version: 0 }, { version: 1.5 }, { requestId: '' }, { requestId: 'r'.repeat(161) },
        { source: { ...run.source, generationId: 'not-an-id' } },
        { source: { ...run.source, downloadUrl: 'https://example.invalid/model.obj' } },
        { parameters: { targetQuads: 499 } }, { parameters: { targetQuads: 100001 } },
        { parameters: { targetQuads: 500.5 } }, { parameters: { script: 'arbitrary' } },
        { script: 'arbitrary' }
    ]) assert.equal(validators.run({ ...run, ...patch }), false, JSON.stringify(patch));
    for (const action of ['status', 'resume', 'cancel']) {
        assert.equal(validators[action]({ projectId: 'project-1', jobId: 'f'.repeat(32) }), true);
        assert.equal(validators[action]({ jobId: 'f'.repeat(32) }), false);
        assert.equal(validators[action]({ projectId: null, jobId: '../job' }), false);
    }
    assert.equal(validators.history({ projectId: null, offset: 0, limit: 100 }), true);
    assert.equal(validators.history({ projectId: null, offset: -1 }), false);
    assert.equal(validators.history({ projectId: null, limit: 101 }), false);
    assert.equal(validators.history({}), false);
    assert.equal(validators.list({ extra: true }), false);
    assert.equal(validators.sources({ accountId: 'account-1' }), true);
    assert.equal(validators.sources({ accountId: '' }), false);
    assert.equal(validators.get({ workflowId: HUNYUAN_RHINO_WORKFLOW.id }), true);
    assert.deepEqual(HUNYUAN_RHINO_WORKFLOW.steps.map(step => step.id),
        ['download', 'connect', 'import', 'inspect', 'clean', 'quad', 'validate']);
});

test('stdio MCP exposes workflows and forwards them directly to workflow routes', async t => {
    const requests = [];
    const bridge = http.createServer(async (req, res) => {
        const body = await readJson(req);
        requests.push({ method: req.method, path: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result: { jobId: 'b'.repeat(32), status: 'queued' } }));
    });
    await listen(bridge);
    t.after(() => closeServer(bridge));
    const client = spawnMcpClient(t, bridge);
    const listed = await client.request('tools/list', {});
    const workflowTools = listed.result.tools.filter(tool => tool.name.startsWith('flow_canvas.workflow.'));
    assert.deepEqual(workflowTools, WORKFLOW_TOOL_DEFINITIONS);
    const readOnly = workflowTools.filter(tool => tool.annotations?.readOnlyHint)
        .map(tool => tool.name.replace('flow_canvas.workflow.', ''));
    assert.deepEqual(readOnly, ['list', 'get', 'sources', 'status', 'history']);
    const inputs = {
        list: {},
        get: { workflowId: 'hunyuan-rhino-cleanup' },
        sources: { accountId: 'account-1' },
        run: { workflowId: 'hunyuan-rhino-cleanup', version: 1, projectId: null,
            requestId: 'request-1', source: { accountId: 'account-1', generationId: 'a'.repeat(32) } },
        status: { projectId: null, jobId: 'b'.repeat(32) },
        history: { projectId: null, limit: 20 },
        resume: { projectId: null, jobId: 'b'.repeat(32) },
        cancel: { projectId: null, jobId: 'b'.repeat(32) }
    };
    for (const [action, input] of Object.entries(inputs)) {
        const name = `flow_canvas.workflow.${action}`;
        const response = await client.request('tools/call', { name, arguments: input });
        assert.deepEqual(JSON.parse(response.result.content[0].text), { jobId: 'b'.repeat(32), status: 'queued' });
        assert.deepEqual(requests.at(-1), { method: 'POST', path: `/workflow/tools/${name}`, body: input });
    }
    const obsolete = await client.request('tools/call', { name: 'flow_canvas.rhino.cleanup', arguments: { stage: 'quad' } });
    assert.equal(obsolete.error.code, -32602);
    assert.equal(requests.length, 8);
});

test('stdio MCP preserves workflow recovery errors', async t => {
    const bridge = http.createServer((_req, res) => {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, code: 'WORKFLOW_CONFLICT', error: 'Request inputs changed',
            details: { jobId: 'b'.repeat(32), recovery: 'Use the original request parameters' } }));
    });
    await listen(bridge);
    t.after(() => closeServer(bridge));
    const response = await spawnMcpClient(t, bridge).request('tools/call', {
        name: 'flow_canvas.workflow.resume', arguments: { projectId: null, jobId: 'b'.repeat(32) }
    });
    assert.equal(response.error.code, -32000);
    assert.deepEqual(response.error.data, { status: 409, code: 'WORKFLOW_CONFLICT',
        details: { jobId: 'b'.repeat(32), recovery: 'Use the original request parameters' } });
});

function spawnMcpClient(t, bridge) {
    const child = spawn(process.execPath, [path.join(__dirname, 'flow-canvas-mcp.mjs')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, FLOW_CANVAS_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}` },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    t.after(() => {
        child.stdin.end();
        if (!child.killed) child.kill();
    });
    return createMcpClient(child);
}

test('official MCP SDK can initialize, discover, and call workflows over JSONL', async t => {
    const requests = [];
    const bridge = http.createServer(async (req, res) => {
        const body = await readJson(req);
        requests.push({ path: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result: { workflows: [HUNYUAN_RHINO_WORKFLOW] } }));
    });
    await listen(bridge);
    t.after(() => closeServer(bridge));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(__dirname, 'flow-canvas-mcp.mjs')],
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, FLOW_CANVAS_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}` },
        stderr: 'pipe'
    });
    const client = new Client({ name: 'workflow-sdk-test', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(transport, { timeout: 5000 });
    const listed = await client.listTools();
    assert.equal(listed.tools.some(tool => tool.name === 'flow_canvas.workflow.run'), true);
    const result = await client.callTool({ name: 'flow_canvas.workflow.list', arguments: {} });
    assert.deepEqual(JSON.parse(result.content[0].text), { workflows: [HUNYUAN_RHINO_WORKFLOW] });
    assert.deepEqual(requests, [{ path: '/workflow/tools/flow_canvas.workflow.list', body: {} }]);
});

test('stdio MCP preserves structured Flow Canvas bridge errors', async (t) => {
    const bridge = http.createServer((_req, res) => {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: 'revision changed',
            code: 'REVISION_CONFLICT',
            details: { expectedRevision: 7, actualRevision: 8 }
        }));
    });
    await listen(bridge);
    t.after(() => closeServer(bridge));

    const child = spawn(process.execPath, [path.join(__dirname, 'flow-canvas-mcp.mjs')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            FLOW_CANVAS_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    const client = createMcpClient(child);
    t.after(() => {
        child.stdin.end();
        if (!child.killed) child.kill();
    });

    const response = await client.request('tools/call', {
        name: 'flow_canvas.board.transaction.apply',
        arguments: { id: 'tx', baseRevision: 7, operations: [{ op: 'node.delete', nodeId: 'a' }] }
    });
    assert.equal(response.error.code, -32000);
    assert.equal(response.error.data.status, 409);
    assert.equal(response.error.data.code, 'REVISION_CONFLICT');
    assert.equal(response.error.data.details.actualRevision, 8);
});

function createMcpClient(child) {
    let nextId = 1;
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    let stderr = '';

    child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const header = buffer.slice(0, headerEnd).toString('utf8');
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) throw new Error(`Invalid MCP header: ${header}`);
            const length = Number(match[1]);
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + length;
            if (buffer.length < bodyEnd) return;
            const message = JSON.parse(buffer.slice(bodyStart, bodyEnd).toString('utf8'));
            buffer = buffer.slice(bodyEnd);
            const waiter = pending.get(message.id);
            if (!waiter) continue;
            pending.delete(message.id);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
        }
    });
    child.once('exit', code => {
        for (const waiter of pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(`MCP process exited with ${code}: ${stderr}`));
        }
        pending.clear();
    });

    return {
        request(method, params) {
            const id = nextId++;
            const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
            const response = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`MCP request timed out: ${method}; stderr: ${stderr}`));
                }, 10_000);
                pending.set(id, { resolve, reject, timer });
            });
            child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
            child.stdin.write(payload);
            return response;
        }
    };
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}

function closeServer(server) {
    return new Promise(resolve => server.close(resolve));
}
