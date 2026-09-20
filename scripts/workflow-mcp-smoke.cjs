const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { keyFor } = require('../electron-main/hunyuan-model-watcher.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2));
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
function within(root, file) {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `Path escaped fixture: ${file}`);
}
async function unusedPort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-workflow-mcp-'));
    const data = path.join(profile, 'data');
    const scriptRoot = path.join(os.tmpdir(), 'corvas-hunyuan-rhino');
    const accountId = randomUUID();
    const generationId = keyFor(randomUUID());
    const cancelGenerationId = keyFor(randomUUID());
    const projectId = 'workflow-smoke';
    const bridgePort = await unusedPort();
    const sessions = new Set();
    const ownedJobIds = new Set();
    const calls = [];
    const objects = new Set();
    let failQuadOnce = true;
    let app, client, clientTransport;

    // Simulate only the report contract. Production services, persistence, IPC,
    // the stdio MCP entry point, and the HTTP MCP client remain unmodified.
    async function runRhinoScript({ cmd }) {
        const match = /^_-RunPythonScript "([^"]+)"$/.exec(cmd);
        assert.ok(match, 'Only a managed script invocation is allowed');
        const script = path.resolve(match[1]);
        within(scriptRoot, script);
        const directory = path.dirname(script);
        const filename = path.basename(script);
        const optionName = { 'import-hunyuan.py': 'import-options.json', 'cleanup-hunyuan.py': 'cleanup-options.json',
            'verify-hunyuan.py': 'verify-options.json' }[filename];
        assert.ok(optionName, 'Unknown Rhino fixture script');
        const options = await readJson(path.join(directory, optionName));
        assert.match(options.jobId, /^[a-f0-9]{32}$/);
        within(path.join(scriptRoot, options.jobId), script);
        if (filename === 'import-hunyuan.py') {
            within(data, options.filePath);
            within(path.join(data, 'rhino-model-results'), options.resultDirectory);
            assert.equal(path.basename(options.resultDirectory), options.jobId);
            assert.ok((await fs.stat(options.filePath)).size > 32);
            ownedJobIds.add(options.jobId);
            const id = `${options.jobId}-source`;
            objects.add(id);
            calls.push({ jobId: options.jobId, stage: 'import' });
            await writeJson(path.join(options.resultDirectory, 'import-result.json'), {
                ok: true, jobId: options.jobId, invocationId: options.invocationId, meshIds: [id], objectIds: [id],
                documentId: 'workflow-mock-document', faceCount: 1500000, meshStats: [{ id, faceCount: 1500000 }]
            });
        } else {
            assert.ok(ownedJobIds.has(options.jobId), 'Only this test may own the referenced job');
            if (filename === 'verify-hunyuan.py') {
                within(path.join(scriptRoot, options.jobId), options.resultFile);
                calls.push({ jobId: options.jobId, stage: 'verify' });
                await writeJson(options.resultFile, { ok: true, jobId: options.jobId, invocationId: options.invocationId,
                    documentId: 'workflow-mock-document', documentEmpty: objects.size === 0,
                    foundIds: options.expectedIds.filter(id => objects.has(id)) });
            } else {
                within(path.join(data, 'rhino-model-results'), options.resultDirectory);
                assert.equal(path.basename(options.resultDirectory), options.jobId);
                assert.ok(['inspect', 'clean', 'quad', 'validate'].includes(options.stage));
                calls.push({ jobId: options.jobId, stage: options.stage, targetQuads: options.targetQuads });
                const failed = options.stage === 'quad' && failQuadOnce;
                if (failed) failQuadOnce = false;
                const source = { id: `${options.jobId}-source`, faces: 1500000 };
                const mesh = { id: `${options.jobId}-${options.stage === 'clean' ? 'clean' : 'quad'}`,
                    faces: 1000, quads: 1000, valid: true, closed: true };
                if (!failed) objects.add(mesh.id);
                await writeJson(path.join(options.resultDirectory, `cleanup-${options.stage}.json`), {
                    ok: !failed, status: failed ? 'failed' : 'completed', stage: options.stage, jobId: options.jobId,
                    invocationId: options.invocationId, targetQuads: options.targetQuads,
                    error: failed ? 'Injected confirmed QuadRemesh failure' : undefined,
                    outputs: failed ? [] : [{ sourceId: source.id, source, mesh }]
                });
            }
        }
        return { content: [{ type: 'text', text: 'Fixture report written' }] };
    }

    const rhino = http.createServer(async (request, response) => {
        try {
            let transport = [...sessions].find(entry => entry.sessionId === request.headers['mcp-session-id']);
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
            if (!transport) {
                if (request.method !== 'POST') { response.writeHead(404).end(); return; }
                const server = new McpServer({ name: 'workflow-rhino-fixture', version: '1.0.0' });
                server.registerTool('rhino_scene', { description: 'Execute an isolated Rhino fixture script',
                    inputSchema: { action: z.literal('script'), cmd: z.string() } }, runRhinoScript);
                transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
                sessions.add(transport);
                await server.connect(transport);
            }
            await transport.handleRequest(request, response, body);
        } catch (error) {
            if (!response.headersSent) response.writeHead(500);
            response.end(error.message);
        }
    });
    await new Promise(resolve => rhino.listen(0, '127.0.0.1', resolve));

    async function connectClient() {
        client = new Client({ name: 'corvas-workflow-smoke', version: '1.0.0' });
        clientTransport = new StdioClientTransport({ command: process.execPath,
            args: [path.join(__dirname, '../mcp/flow-canvas-mcp.mjs')],
            env: { ...process.env, FLOW_CANVAS_BRIDGE_URL: `http://127.0.0.1:${bridgePort}` }, stderr: 'pipe' });
        await client.connect(clientTransport, { timeout: 10000 });
    }
    async function closeClient() {
        await client?.close();
        client = null;
        clientTransport = null;
    }
    async function invoke(action, args = {}) {
        const result = await client.callTool({ name: `flow_canvas.workflow.${action}`, arguments: args }, undefined, { timeout: 15000 });
        assert.ok(!result.isError, JSON.stringify(result));
        return JSON.parse(result.content.find(entry => entry.type === 'text').text);
    }
    async function launch() {
        const env = { ...process.env, FLOW_WORKFLOW_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'workflow-smoke-entry.cjs')], env });
        await connectClient();
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            try { await invoke('list'); ready = true; break; } catch { await pause(100); }
        }
        assert.ok(ready, 'Corvas bridge did not start');
    }
    async function pollJob(jobId, predicate) {
        let latest;
        for (let attempt = 0; attempt < 160; attempt++) {
            latest = await invoke('status', { projectId, jobId });
            if (predicate(latest)) return latest;
            await pause(100);
        }
        assert.fail(`Workflow timed out: ${JSON.stringify(latest)}`);
    }
    try {
        await fs.mkdir(data);
        await fs.writeFile(path.join(profile, 'workflow-smoke.marker'), 'isolated fixture');
        await fs.writeFile(path.join(profile, 'Rhino.exe'), 'fixture only');
        await writeJson(path.join(data, 'board.json'), { version: 1, activeGroupId: projectId, items: [], connections: [],
            folderGroups: [projectId, 'other-project'].map(id => ({ id, name: id, savedItems: [], connections: [], folders: [], boardRevision: 0 })),
            mcp: { enabled: true, port: bridgePort }, viewport: { x: 0, y: 0, scale: 1 } });
        await writeJson(path.join(data, 'hunyuan-accounts.json'), { version: 1,
            accounts: [{ id: accountId, name: 'Isolated workflow fixture', createdAt: new Date().toISOString() }] });
        await writeJson(path.join(data, 'rhino-workbench.json'), { version: 1, executablePath: path.join(profile, 'Rhino.exe'),
            endpoint: `http://127.0.0.1:${rhino.address().port}/mcp`, serverId: '' });
        for (const id of [generationId, cancelGenerationId]) {
            const directory = path.join(data, 'hunyuan-browser-profiles', accountId, 'rhino-models', keyFor(id));
            await fs.mkdir(directory, { recursive: true });
            await fs.writeFile(path.join(directory, 'model.fbx'), Buffer.alloc(64, 1));
        }
        await launch();
        const tools = (await client.listTools()).tools;
        for (const name of ['list', 'get', 'sources', 'run', 'status', 'history', 'resume', 'cancel']) {
            assert.ok(tools.some(tool => tool.name === `flow_canvas.workflow.${name}`), `Missing MCP tool ${name}`);
        }
        assert.equal((await invoke('list')).requiresTextProvider, false);
        const definition = await invoke('get', { workflowId: 'hunyuan-rhino-cleanup' });
        assert.equal(definition.version, 1);
        assert.equal((await invoke('sources', { accountId })).accounts[0].id, accountId);
        const request = { workflowId: definition.id, version: definition.version, projectId, requestId: 'stable',
            source: { accountId, generationId }, parameters: { targetQuads: 1000 } };
        const submitted = await invoke('run', request);
        assert.equal(submitted.status, 'queued');
        assert.equal(submitted.reused, false);
        const jobId = submitted.id;
        assert.equal((await invoke('run', request)).id, jobId);
        await assert.rejects(invoke('run', { ...request, parameters: { targetQuads: 2000 } }), /requestId|IDEMPOTENCY|不同输入/);
        await closeClient();
        await connectClient();
        assert.equal((await invoke('status', { projectId, jobId })).id, jobId);
        const interrupted = await pollJob(jobId, job => job.canResume);
        assert.equal(interrupted.stages.find(stage => stage.stage === 'clean').status, 'completed');
        assert.equal(interrupted.stages.find(stage => stage.stage === 'quad').status, 'failed');
        const originalRunId = interrupted.runId;
        assert.ok(originalRunId);
        assert.equal(calls.filter(call => call.stage === 'import').length, 1);
        assert.equal((await invoke('history', { projectId })).total, 1);
        assert.equal((await invoke('history', { projectId: 'other-project' })).total, 0);
        for (const action of ['status', 'resume', 'cancel']) {
            await assert.rejects(invoke(action, { projectId: 'other-project', jobId }), /PROJECT_MISMATCH|其他项目/);
        }
        assert.ok((await invoke('sources', { accountId })).sources.some(source => source.generationId === generationId));
        await closeClient();
        await app.close(); app = null;
        await launch();
        assert.equal((await invoke('history', { projectId })).jobs[0].id, jobId);
        assert.equal((await invoke('run', request)).id, jobId);
        await invoke('resume', { projectId, jobId });
        const completed = await pollJob(jobId, job => job.status === 'completed');
        assert.equal(completed.runId, originalRunId);
        assert.equal(completed.outputs[0].quads, 1000);
        assert.equal(calls.filter(call => call.stage === 'import').length, 1);
        assert.equal(calls.filter(call => call.stage === 'clean').length, 1);
        assert.equal(calls.filter(call => call.stage === 'quad').length, 2);
        assert.ok(calls.filter(call => call.stage === 'quad').every(call => call.targetQuads === 1000));
        assert.equal((await invoke('resume', { projectId, jobId })).status, 'completed');
        assert.equal((await invoke('run', request)).reused, true);
        const canceled = await invoke('run', { ...request, requestId: 'cancel-before-dispatch', source: { accountId, generationId: cancelGenerationId } });
        await invoke('cancel', { projectId, jobId: canceled.id });
        await pause(1700);
        assert.equal((await invoke('status', { projectId, jobId: canceled.id })).status, 'canceled');
        assert.equal(calls.filter(call => call.stage === 'import').length, 1);
        await assert.rejects(fs.access(path.join(profile, 'unexpected-provider-calls.log')), { code: 'ENOENT' });
        console.log('Workflow MCP smoke passed: official stdio client, Electron bridge, local Rhino MCP, persistent task, confirmed failure, app restart, same-run resume, stage reuse, client reconnect, idempotency conflict, project isolation, cancellation, and zero model-provider calls.');
    } finally {
        await closeClient().catch(() => {});
        await app?.close().catch(() => {});
        for (const transport of sessions) await transport.close().catch(() => {});
        rhino.closeAllConnections();
        await new Promise(resolve => rhino.close(resolve));
        for (const jobId of ownedJobIds) {
            const directory = path.join(scriptRoot, jobId);
            within(scriptRoot, directory);
            await fs.rm(directory, { recursive: true, force: true });
        }
        within(os.tmpdir(), profile);
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
