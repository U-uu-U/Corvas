const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { toolId } = require('../electron-main/mcp-client.cjs');

(async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { z } = require('zod');
    const live = process.env.FLOW_RHINO_SMOKE_LIVE === '1';
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-rhino-ui-'));
    const output = path.join(__dirname, '../output/playwright');
    let app, page, expectedToolName, toolCalls = 0, providerCalls = 0;
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
    const provider = http.createServer(async (request, response) => {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); providerCalls++;
        const observed = body.messages.some(message => message.role === 'tool');
        const tool = body.tools.find(tool => tool.function.name === expectedToolName);
        if (!tool) { response.writeHead(500).end('Rhino tool was not exposed to the Agent'); return; }
        const message = observed ? { role: 'assistant', content: 'Rhino has one mesh with 100 faces.' }
            : { role: 'assistant', content: '', tool_calls: [{ id: 'rhino-read', type: 'function', function: { name: tool.function.name, arguments: '{"action":"objects"}' } }] };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message, finish_reason: observed ? 'stop' : 'tool_calls' }] }));
    });
    await new Promise(resolve => mcpHttp.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    try {
        await fs.mkdir(path.join(profile, 'data')); await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(profile, 'Rhino.exe'), 'fixture');
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'rhino-smoke', items: [], connections: [],
            folderGroups: [{ id: 'rhino-smoke', name: 'Rhino', savedItems: [], connections: [], folders: [], boardRevision: 0 }], mcp: { enabled: false } }));
        const env = { ...process.env, FLOW_RHINO_SMOKE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'rhino-smoke-entry.cjs')], env });
        for (let attempt = 0; attempt < 150; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break; await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
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
        expectedToolName = 't_' + crypto.createHash('sha256').update(toolId(saved.servers[0].id, 'rhino_scene')).digest('hex').slice(0, 60);
        await panel.locator('[data-action="open"]').click();
        assert.equal((await page.evaluate(() => window.flowCanvas.mcpClient.list())).servers.length, 1);
        for (const theme of ['dark', 'light']) {
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            await page.screenshot({ path: path.join(output, `rhino-workbench-${theme}.png`) });
        }
        await panel.locator('[data-action="inspect"]').click();
        await page.waitForSelector('#agentInput', { state: 'visible' });
        assert.match(await page.locator('#agentInput').inputValue(), /不要修改模型/);
        const selectedSkills = await page.evaluate(() => JSON.parse(localStorage.getItem('flow-canvas-agent-global')).agentSkillIds);
        assert.ok(selectedSkills.includes('rhino-model-editing'));
        const run = await page.evaluate(endpoint => window.flowCanvas.agent.start({ projectId: 'rhino-smoke', conversationId: 'rhino-check',
            messages: [{ role: 'user', content: 'Inspect the Rhino scene.' }], provider: { type: 'openai', endpoint, model: 'test', apiKey: 'fixture-key' } }),
        `http://127.0.0.1:${provider.address().port}/v1/chat/completions`);
        let result;
        for (let attempt = 0; attempt < 200; attempt++) {
            result = await page.evaluate(id => window.flowCanvas.agent.get({ runId: id }), run.id);
            if (['completed', 'failed'].includes(result.status)) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(result.status, 'completed', result.error);
        assert.equal(toolCalls, live ? 0 : 1); assert.equal(providerCalls, 2);
        await page.locator('#agentSidebarCloseBtn').click();
        await page.locator('#agentToggleBtn').hover(); await page.locator('#corvasAppLauncher [data-app="rhino"]').click();
        await page.waitForFunction(() => !document.querySelector('#rhinoWorkbenchPanel [data-action="open"]').disabled);
        await (await app.browserWindow(page)).evaluate(window => window.setSize(820, 680));
        await page.waitForTimeout(350);
        const bounds = await panel.boundingBox(); const viewport = await page.evaluate(() => innerWidth);
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport + 1);
        await page.screenshot({ path: path.join(output, 'rhino-workbench-compact.png') });
        console.log(`Rhino workbench ${live ? 'LIVE' : 'mock'} smoke passed: launcher, shared MCP discovery, no duplicate connection, Agent scene read, Skill draft, themes and compact layout.`);
    } catch (error) {
        await page?.screenshot({ path: path.join(output, 'rhino-workbench-failure.png') }).catch(() => {}); throw error;
    } finally {
        await app?.close();
        for (const transport of transports) await transport.close();
        mcpHttp.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => mcpHttp.close(resolve)), new Promise(resolve => provider.close(resolve))]);
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
