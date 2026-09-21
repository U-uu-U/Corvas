const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

(async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { z } = require('zod');
    const live = process.env.FLOW_RHINO_SMOKE_LIVE === '1';
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-rhino-ui-'));
    const output = path.join(__dirname, '../output/playwright');
    let app, page, client, toolCalls = 0;
    const transports = new Set();
    const mcpHttp = http.createServer(async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        let transport = [...transports].find(entry => entry.sessionId === request.headers['mcp-session-id']);
        if (!transport) {
            const server = new McpServer({ name: 'rhino-smoke', version: '1.0.0' });
            server.registerTool('rhino_scene', { description: 'Rhino read test scene', inputSchema: { action: z.literal('objects') }, annotations: { readOnlyHint: true } },
                async () => { toolCalls++; return { content: [{ type: 'text', text: JSON.stringify({ objects: [{ id: 'fixture-mesh', type: 'mesh', faces: 100 }] }) }] }; });
            transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
            transports.add(transport); await server.connect(transport);
        }
        await transport.handleRequest(request, response, body);
    });
    await new Promise(resolve => mcpHttp.listen(0, '127.0.0.1', resolve));
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const bridgePort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    try {
        await fs.mkdir(path.join(profile, 'data')); await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(profile, 'Rhino.exe'), 'fixture');
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'rhino-smoke', items: [], connections: [],
            folderGroups: [{ id: 'rhino-smoke', name: 'Rhino', savedItems: [], connections: [], folders: [], boardRevision: 0 }],
            mcp: { enabled: true, port: bridgePort } }));
        const env = { ...process.env, FLOW_RHINO_SMOKE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: ['--disable-gpu', path.join(__dirname, 'rhino-smoke-entry.cjs')], env });
        for (let attempt = 0; attempt < 150; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break; await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForSelector('#rhinoWorkbenchPanel', { state: 'attached' });
        await page.evaluate(endpoint => window.flowCanvas.rhino.save({ endpoint }), live ? 'http://127.0.0.1:26929/mcp' : `http://127.0.0.1:${mcpHttp.address().port}/mcp`);
        await page.locator('#agentToggleBtn').hover();
        await page.locator('#corvasAppLauncher [data-app="rhino"]').click();
        const panel = page.locator('#rhinoWorkbenchPanel');
        await page.waitForFunction(() => document.querySelector('#rhinoWorkbenchPanel').dataset.state === 'connected');
        assert.match(await panel.innerText(), live ? /7 个工具/ : /1 个工具/);
        assert.equal(toolCalls, 0, 'Opening Rhino must not modify or inspect geometry automatically');
        const saved = await page.evaluate(() => window.flowCanvas.mcpClient.list());
        assert.equal(saved.servers.length, 1);
        await panel.locator('[data-action="open"]').click();
        assert.equal((await page.evaluate(() => window.flowCanvas.mcpClient.list())).servers.length, 1);
        await panel.locator('[data-action="inspect"]').click();
        await page.waitForFunction(() => document.querySelector('#rhinoWorkbenchPanel .external-handoff-task strong')?.textContent === '待 Codex 接手');
        assert.ok(await page.locator('body').evaluate(body => body.classList.contains('rhino-mode') && !body.classList.contains('agent-mode')));
        const created = await page.evaluate(() => window.flowCanvas.handoff.list({ projectId: 'rhino-smoke', target: 'rhino' }));
        assert.equal(created.tasks.length, 1);
        const task = created.tasks[0];
        assert.match(task.instruction, /不要修改模型/);
        assert.equal(toolCalls, 0, 'Creating a handoff must not inspect the external scene');
        client = new Client({ name: 'codex-rhino-smoke', version: '1.0' });
        await client.connect(new StdioClientTransport({ command: process.execPath,
            args: [path.join(__dirname, '../mcp/flow-canvas-mcp.mjs')],
            env: { ...process.env, FLOW_CANVAS_BRIDGE_URL: `http://127.0.0.1:${bridgePort}` }, stderr: 'pipe' }));
        const handoff = async (action, input) => {
            const result = await client.callTool({ name: `flow_canvas.handoff.${action}`, arguments: input });
            assert.notEqual(result.isError, true, JSON.stringify(result));
            const receipt = JSON.parse(result.content[0].text);
            return action === 'call' ? { ...receipt, content: result.content.slice(1) } : receipt;
        };
        const scope = { projectId: 'rhino-smoke', taskId: task.id };
        const owner = { ...scope, clientId: 'codex-rhino-smoke' };
        assert.equal((await handoff('claim', owner)).status, 'running');
        const discovered = await handoff('tools', scope);
        const tool = discovered.tools.find(tool => tool.name === 'rhino_scene');
        assert.ok(tool, 'Rhino MCP tools must be discoverable by the external client');
        const call = { ...owner, serverId: tool.serverId, toolName: tool.name, binding: tool.binding,
            requestId: 'rhino-inspect-1', arguments: { action: 'objects' } };
        const called = await handoff('call', call);
        assert.equal(called.status, 'completed');
        if (!live) {
            const scene = JSON.parse(called.content.find(block => block.type === 'text').text);
            assert.deepEqual(scene.objects, [{ id: 'fixture-mesh', type: 'mesh', faces: 100 }]);
        }
        assert.equal((await handoff('call', call)).reused, true);
        assert.equal(toolCalls, live ? 0 : 1, 'Repeating a request must reuse the saved scene result');
        await handoff('update', { ...owner, status: 'completed', summary: '已读取 Rhino 场景，模型保持不变' });
        await page.waitForFunction(() => document.querySelector('#rhinoWorkbenchPanel .external-handoff-task strong')?.textContent === '完成');
        assert.deepEqual(await page.evaluate(() => window.flowCanvas.agent.list({ projectId: 'rhino-smoke' })), [],
            'External handoff must not start an internal Agent or text model run');
        assert.equal((await page.evaluate(() => window.flowCanvas.mcpClient.list())).servers.length, 1);
        for (const theme of ['dark', 'light']) {
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            await page.screenshot({ path: path.join(output, `rhino-workbench-${theme}.png`) });
        }
        await page.waitForFunction(() => !document.querySelector('#rhinoWorkbenchPanel [data-action="open"]').disabled);
        await (await app.browserWindow(page)).evaluate(window => window.setSize(820, 680));
        await page.waitForTimeout(350);
        const bounds = await panel.boundingBox(); const viewport = await page.evaluate(() => innerWidth);
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport + 1);
        assert.ok(await panel.locator('.external-handoff').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
        await panel.locator('.external-handoff-task').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, 'rhino-workbench-compact.png') });
        assert.deepEqual(errors, []);
        console.log(`Rhino workbench ${live ? 'LIVE' : 'mock'} smoke passed: launcher, connection reuse, external handoff claim/discovery/HTTP scene call/replay/status, no internal Agent, themes and compact layout.`);
    } catch (error) {
        await page?.screenshot({ path: path.join(output, 'rhino-workbench-failure.png') }).catch(() => {}); throw error;
    } finally {
        await client?.close();
        await app?.close();
        for (const transport of transports) await transport.close();
        mcpHttp.closeAllConnections();
        await new Promise(resolve => mcpHttp.close(resolve));
        assert.ok(profile.startsWith(path.join(os.tmpdir(), 'corvas-rhino-ui-')));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
