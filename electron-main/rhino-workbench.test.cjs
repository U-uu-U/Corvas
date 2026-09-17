const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RhinoWorkbench, DEFAULT_RHINO_ENDPOINT, normalizeEndpoint } = require('./rhino-workbench.cjs');

function setup(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-rhino-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const actions = [], servers = [], events = [];
    const executable = path.join(directory, 'Rhino.exe'); fs.writeFileSync(executable, 'fixture');
    const desktop = {
        discover: async () => [{ path: executable, name: 'Rhino 8' }, { path: executable, name: 'Rhino 7 alias' }],
        running: async () => [], validPath: file => file === executable,
        launch: async file => actions.push(['launch', file]), focus: async file => actions.push(['focus', file]),
        bootstrap: async file => actions.push(['bootstrap', file]), bootstrapReport: () => null,
        connectionCommand: () => '_-RunPythonScript "fixture.py"', ...options.desktop
    };
    const mcpClient = {
        list: () => ({ servers }),
        save: async input => {
            const index = servers.findIndex(server => server.id === input.id);
            if (index < 0) servers.push({ ...input, id: 'rhino-test', status: 'disconnected', tools: [] });
            else servers[index] = { ...servers[index], ...input };
            actions.push(['save', input]); return { servers };
        },
        connect: async id => {
            const server = servers.find(server => server.id === id);
            server.status = 'connected'; server.tools = [{ name: 'rhino_scene' }, { name: 'gh_inspect' }];
            actions.push(['connect', id]);
        },
        disconnect: async id => { servers.find(server => server.id === id).status = 'disconnected'; }
    };
    let probes = 0;
    const service = new RhinoWorkbench({ directory, desktop, mcpClient,
        probe: options.probe || (async () => ++probes > 1), wait: async () => {}, startupAttempts: 3,
        onChange: data => events.push(data) });
    return { service, desktop, mcpClient, directory, actions, servers, executable, events };
}

test('cold launch starts Rhino once then publishes Cordyceps tools through the existing MCP client', async t => {
    const { service, actions, servers, events } = setup(t);
    assert.equal(service.open().busy, true);
    service.open();
    await service.pending;
    assert.equal(actions.filter(action => action[0] === 'launch').length, 1);
    assert.equal(service.snapshot().connected, true);
    assert.equal(service.snapshot().toolCount, 2);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].url, DEFAULT_RHINO_ENDPOINT);
    assert.equal(servers[0].timeoutMs, 300000);
    assert.ok(events.some(state => state.state === 'launching'));
    assert.equal(service.snapshot().applications.length, 1);
    assert.equal(service.snapshot().busy, false);
});

test('an already configured running service is reused without changing credentials or duplicating Rhino', async t => {
    const { service, servers, actions, executable, desktop } = setup(t, { probe: async () => true });
    servers.push({ id: 'existing', transport: 'http', url: 'http://localhost:26929/mcp', enabled: true,
        headers: { Authorization: 'fixture-secret' }, timeoutMs: 200000, status: 'connected', tools: [{ name: 'rhino_scene' }] });
    desktop.running = async () => [{ path: executable, pid: 123 }];
    service.open(); await service.pending;
    assert.equal(servers.length, 1);
    assert.equal(service.snapshot().serverId, 'existing');
    assert.equal(actions.some(action => action[0] === 'launch' || action[0] === 'save'), false);
    assert.deepEqual(servers[0].headers, { Authorization: 'fixture-secret' });
    assert.ok(actions.some(action => action[0] === 'focus'));
});

test('connection-only does not start an application or modify documents when no bridge is listening', async t => {
    const { service, actions } = setup(t, { probe: async () => false });
    service.open({ connectOnly: true }); await service.pending;
    assert.equal(service.snapshot().state, 'error');
    assert.match(service.snapshot().message, /尚未启动/);
    assert.deepEqual(actions, []);
});

test('running Rhino is focused and bootstrapped rather than launched again', async t => {
    const { service, desktop, executable, actions } = setup(t);
    desktop.running = async () => [{ path: executable, pid: 123 }];
    service.open(); await service.pending;
    assert.equal(service.snapshot().connected, true);
    assert.deepEqual(actions.slice(0, 2), [['focus', executable], ['bootstrap', executable]]);
    assert.equal(actions.some(action => action[0] === 'launch'), false);
});

test('missing plugin and solver pause produce actionable failures, never phantom connections', async t => {
    for (const [code, message] of [['PLUGIN_MISSING', /未加载 Cordyceps/], ['SOLVER_DISABLED', /计算已暂停/]]) {
        const { service, servers } = setup(t, { probe: async () => false, desktop: { bootstrapReport: () => ({ ok: false, code }) } });
        service.open(); await service.pending;
        assert.equal(service.snapshot().connected, false);
        assert.match(service.snapshot().message, message);
        assert.equal(servers.length, 0);
    }
});

test('selected executable and endpoint survive reload and foreign hosts cannot alias the local bridge', async t => {
    const { service, directory, desktop, mcpClient, executable, servers } = setup(t, { probe: async () => true });
    servers.push({ id: 'remote', transport: 'http', url: 'http://remote.example:26929/mcp', tools: [] });
    await service.save({ executablePath: executable, endpoint: DEFAULT_RHINO_ENDPOINT });
    service.open(); await service.pending;
    assert.equal(servers.length, 2);
    assert.notEqual(service.snapshot().serverId, 'remote');
    const restored = new RhinoWorkbench({ directory, desktop, mcpClient });
    assert.equal(restored.snapshot().executablePath, executable);
    await assert.rejects(service.save({ executablePath: path.join(directory, 'unknown.exe') }), /Rhino 程序/);
    assert.throws(() => normalizeEndpoint('https://remote.example/mcp'), /本机地址/);
});

test('a disconnected shared MCP updates the status without killing the user application', async t => {
    const { service, servers } = setup(t);
    service.open(); await service.pending;
    servers[0].status = 'disconnected';
    assert.equal(service.snapshot().state, 'disconnected');
    assert.equal(service.snapshot().connected, false);
    service.close();
    assert.throws(() => service.open(), /已关闭/);
});

test('closing Rhino clears a stale connected badge and withdraws the MCP connection on refresh', async t => {
    const { service, servers } = setup(t);
    service.open(); await service.pending;
    service.probe = async () => false;
    const status = await service.status();
    assert.equal(status.connected, false);
    assert.equal(status.state, 'disconnected');
    assert.equal(servers[0].status, 'disconnected');
});

test('corrupt settings are preserved and multiple running instances are not modified by guessing', async t => {
    const { service, directory, desktop, mcpClient, executable, actions } = setup(t, { probe: async () => false });
    desktop.running = async () => [{ path: executable, pid: 1 }, { path: executable, pid: 2 }];
    service.open(); await service.pending;
    assert.match(service.snapshot().message, /多个 Rhino/);
    assert.deepEqual(actions, []);
    fs.writeFileSync(service.file, '{corrupt');
    const restored = new RhinoWorkbench({ directory, desktop, mcpClient });
    await assert.rejects(restored.save({ executablePath: executable }), /读取失败/);
    assert.equal(fs.readFileSync(service.file, 'utf8'), '{corrupt');
});
