const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const FlowCanvasBridge = require('./mcp-bridge');
const { DEFAULT_MCP_CONFIG } = require('../shared/plan-service-core.cjs');

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

async function startBridge(t, config = {}) {
    const port = await freePort();
    const bridge = new FlowCanvasBridge({
        store: { load: () => ({ folderGroups: [], activeGroupId: 'group-1', mcp: {} }), save: () => true },
        getMainWindow: () => null
    });
    bridge.start({ ...DEFAULT_MCP_CONFIG, host: '127.0.0.1', port, ...config });
    if (!bridge.server.listening) await new Promise(resolve => bridge.server.once('listening', resolve));
    t.after(() => bridge.stop());
    return { bridge, port, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}

async function connect(t, url) {
    const client = new Client({ name: 'corvas-http-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    t.after(() => client.close());
    return client;
}

test('Streamable HTTP MCP endpoint lists the same tools and calls through the bridge', async t => {
    const { port, url } = await startBridge(t);
    const client = await connect(t, url);

    assert.equal(client.getServerVersion().name, 'flow-canvas-mcp');
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    assert.ok(names.includes('flow_canvas.health'));
    assert.ok(names.includes('flow_canvas.board.get_snapshot'));
    assert.ok(names.includes('flow_canvas.handoff.call'));

    const result = await client.callTool({ name: 'flow_canvas.health', arguments: {} });
    const health = JSON.parse(result.content[0].text);
    assert.equal(health.activeGroupId, 'group-1');
    assert.equal(health.mcp.url, `http://127.0.0.1:${port}/mcp`);
});

test('Streamable HTTP MCP endpoint still enforces the allowed tool list', async t => {
    const { url } = await startBridge(t, {
        allowedTools: DEFAULT_MCP_CONFIG.allowedTools.filter(name => name !== 'flow_canvas.context.get_active_group')
    });
    const client = await connect(t, url);
    await assert.rejects(client.callTool({ name: 'flow_canvas.context.get_active_group', arguments: {} }), /not allowed/);
});

test('Streamable HTTP MCP endpoint rejects unknown tools as MCP errors', async t => {
    const { url } = await startBridge(t);
    const client = await connect(t, url);
    await assert.rejects(client.callTool({ name: 'flow_canvas.missing', arguments: {} }), /Unknown tool/);
});

test('closeServer stops listening, keeps renderer readiness, and start restarts it', async t => {
    const { bridge, port, url } = await startBridge(t);
    bridge.setBoardToolsReady(true);
    bridge.closeServer();
    assert.equal(bridge.server, null);
    assert.equal(bridge.boardToolsReady, true);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));

    bridge.start({ ...DEFAULT_MCP_CONFIG, host: '127.0.0.1', port });
    if (!bridge.server.listening) await new Promise(resolve => bridge.server.once('listening', resolve));
    const client = await connect(t, url);
    const result = await client.callTool({ name: 'flow_canvas.health', arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).mcp.port, port);
});

test('a port already in use is reported and leaves the bridge restartable', async t => {
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve));
    t.after(() => blocker.close());
    const bridge = new FlowCanvasBridge({
        store: { load: () => ({ folderGroups: [], mcp: {} }), save: () => true },
        getMainWindow: () => null
    });
    t.after(() => bridge.stop());
    bridge.start({ ...DEFAULT_MCP_CONFIG, host: '127.0.0.1', port });
    await new Promise(resolve => bridge.server.once('error', () => setImmediate(resolve)));
    assert.equal(bridge.server, null);
    assert.equal(bridge.lastListenError, `端口 ${port} 已被占用`);
});

test('Streamable HTTP MCP endpoint rejects foreign Host and Origin headers', async t => {
    const { port } = await startBridge(t);
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    const post = headers => new Promise((resolve, reject) => {
        const req = require('node:http').request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {
            'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end(init);
    });
    assert.equal(await post({ Host: 'evil.example' }), 403);
    assert.equal(await post({ Origin: 'http://evil.example' }), 403);
    assert.equal(await post({}), 200);
});
