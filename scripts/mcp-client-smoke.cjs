const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-mcp-ui-'));
    let app;
    let page;
    let client;
    let originalClipboard;
    let providerCalls = 0;
    const provider = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        providerCalls++;
        assert.ok(body.tools.every(tool => !tool.function.name.startsWith('external_mcp_')
            && tool.function.name !== 'flow_canvas.rhino.cleanup'));
        const message = { role: 'assistant', content: 'External scene tasks are handled in Codex.' };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const bridgePort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    try {
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'mcp-smoke', items: [],
            connections: [], folderGroups: [{ id: 'mcp-smoke', name: 'MCP test', savedItems: [], connections: [], folders: [], boardRevision: 0 }],
            mcp: { enabled: true, port: bridgePort }, viewport: { x: 0, y: 0, scale: 1 } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: ['--disable-gpu', path.join(__dirname, 'external-handoff-smoke-entry.cjs')], env });
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'The main window must open');
        originalClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForSelector('#agentSettingsBtn');
        await page.locator('#agentSettingsBtn').click();
        await page.locator('#agentApiSettingsTab').click();
        const root = page.locator('#mcpClientSettings');
        await root.locator('[data-action=add]').click();
        await root.locator('[name=name]').fill('Blender / Rhino 测试连接');
        await root.locator('[name=command]').fill(process.execPath);
        await root.locator('[name=args]').fill(JSON.stringify([path.join(__dirname, 'fixtures/mcp-client-server.cjs')]));
        await root.locator('[name=env]').fill(JSON.stringify({ FLOW_MCP_TEST_MARKER: 'ui-marker' }));
        await root.locator('[type=submit]').click();
        await page.waitForFunction(() => document.querySelector('#mcpClientSettings [role=status]').textContent.includes('工具已就绪'));
        assert.match(await root.innerText(), /1 个工具/);
        await root.locator('summary').click();
        assert.match(await root.innerText(), /scene.inspect/);
        const run = await page.evaluate(endpoint => window.flowCanvas.agent.start({ projectId: 'mcp-smoke', conversationId: 'mcp-smoke',
            messages: [{ role: 'user', content: 'Read the external scene.' }],
            provider: { type: 'openai', endpoint, model: 'test-model', apiKey: 'fixture-key' } }),
        `http://127.0.0.1:${provider.address().port}/v1/chat/completions`);
        let result;
        const deadline = Date.now() + 15000;
        do {
            result = await page.evaluate(id => window.flowCanvas.agent.get({ runId: id }), run.id);
            if (['completed', 'failed'].includes(result.status)) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        assert.equal(result.status, 'completed', result.error);
        assert.equal(result.projectId, 'mcp-smoke'); assert.equal(result.conversationId, 'mcp-smoke');
        assert.equal(providerCalls, 1);
        assert.equal(Object.keys(result.externalCalls || {}).length, 0);
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        await root.screenshot({ path: path.join(__dirname, '../output/playwright/mcp-settings-connected.png') });
        await page.locator('#agentToggleBtn').hover();
        await page.locator('#corvasAppLauncher [data-app=blender]').click();
        const panel = page.locator('#blenderWorkbenchPanel');
        await page.waitForFunction(() => document.querySelector('#blenderWorkbenchPanel').dataset.state === 'connected');
        await panel.locator('[data-action=inspect]').click();
        await page.waitForFunction(() => document.querySelector('#blenderWorkbenchPanel .external-handoff-task strong')?.textContent === '待 Codex 接手');
        assert.ok(await page.locator('body').evaluate(body => body.classList.contains('blender-mode') && !body.classList.contains('agent-mode')));
        const created = await page.evaluate(() => window.flowCanvas.handoff.list({ projectId: 'mcp-smoke', target: 'blender' }));
        assert.equal(created.tasks.length, 1);
        const task = created.tasks[0];
        await panel.locator('[data-handoff-action=copy]').click();
        const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
        assert.ok(clipboard.includes(task.id) && clipboard.includes('mcp-smoke'));
        client = new Client({ name: 'codex-handoff-smoke', version: '1.0' });
        await client.connect(new StdioClientTransport({ command: process.execPath,
            args: [path.join(__dirname, '../mcp/flow-canvas-mcp.mjs')],
            env: { ...process.env, FLOW_CANVAS_BRIDGE_URL: `http://127.0.0.1:${bridgePort}` }, stderr: 'pipe' }));
        const handoff = async (action, input) => client.callTool({ name: `flow_canvas.handoff.${action}`, arguments: input });
        const scope = { projectId: 'mcp-smoke', taskId: task.id };
        const owner = { ...scope, clientId: 'codex-smoke' };
        await handoff('claim', owner);
        const discovered = JSON.parse((await handoff('tools', scope)).content[0].text);
        const tool = discovered.tools.find(tool => tool.name === 'scene.inspect');
        assert.ok(tool, 'Connected software tool must be exposed to the external client');
        const call = { ...owner, serverId: tool.serverId, toolName: tool.name, binding: tool.binding,
            requestId: 'scene-inspect-1', arguments: { label: 'External Codex' } };
        const called = await handoff('call', call);
        assert.match(called.content.map(block => block.text || '').join('\n'), /objectCount/);
        assert.equal(JSON.parse((await handoff('call', call)).content[0].text).reused, true);
        await handoff('update', { ...owner, status: 'completed', summary: '已读取 3 个场景对象' });
        await page.waitForFunction(() => document.querySelector('#blenderWorkbenchPanel .external-handoff-task strong')?.textContent === '完成');
        assert.equal(providerCalls, 1, 'External calls must not invoke the internal text model');
        for (const [label, width] of [['desktop', 1280], ['compact', 900]]) {
            await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()
                .find(window => window.webContents.getURL().includes('index.html')).setSize(width, 800), width);
            assert.ok(await panel.locator('.external-handoff').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
            await panel.screenshot({ path: path.join(__dirname, `../output/playwright/external-handoff-${label}.png`) });
        }
        await client.close(); client = null;
        await page.locator('#agentSettingsBtn').click();
        await page.locator('#agentApiSettingsTab').click();
        await root.locator('[data-action=edit]').click();
        assert.equal(await root.locator('[name=env]').inputValue(), '');
        await root.locator('[name=name]').fill('Blender / Rhino');
        await root.locator('[type=submit]').click();
        await page.waitForFunction(() => document.querySelector('#mcpClientSettings [role=status]').textContent.includes('工具已就绪'));
        await root.locator('[data-action=toggle]').click();
        await page.waitForFunction(() => document.querySelector('#mcpClientSettings').textContent.includes('已停用'));
        const saved = await page.evaluate(() => window.flowCanvas.mcpClient.list());
        assert.equal(saved.servers[0].enabled, false);
        assert.equal(saved.servers[0].hasEnv, true);
        await root.locator('[data-action=edit]').click();
        await root.locator('[name=transport]').selectOption('http');
        assert.equal(await root.locator('[name=command]').isVisible(), false);
        assert.equal(await root.locator('[name=url]').isVisible(), true);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.isVisible()).setSize(900, 720));
        await root.locator('[name=url]').fill('http://127.0.0.1:1/mcp');
        await root.locator('[name=timeout]').fill('1');
        await root.locator('[name=enabled]').check();
        await root.locator('form').screenshot({ path: path.join(__dirname, '../output/playwright/mcp-settings-form.png') });
        await root.locator('[type=submit]').click();
        await page.waitForFunction(() => document.querySelector('#mcpClientSettings [role=status]').classList.contains('error'));
        assert.match(await root.innerText(), /fetch failed|connect|连接/i);
        await root.locator('[data-action=remove]').click();
        await page.waitForFunction(() => !document.querySelector('#mcpClientSettings [data-id]'));
        assert.deepEqual(errors, []);
        console.log('MCP desktop smoke passed: internal Agent isolation; Blender UI handoff; real stdio external discovery/call/replay/status; settings edit/secret preservation/disable/error/delete.');
    } catch (error) {
        if (page && !page.isClosed()) {
            console.error('MCP UI status:', await page.locator('#mcpClientSettings [role=status]').textContent().catch(() => 'unavailable'));
            await page.screenshot({ path: path.join(__dirname, '../output/playwright/external-handoff-failure.png') }).catch(() => {});
        }
        throw error;
    } finally {
        await client?.close();
        if (app && originalClipboard !== undefined) await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), originalClipboard).catch(() => {});
        await app?.close();
        provider.closeAllConnections();
        await new Promise(resolve => provider.close(resolve));
        assert.ok(profile.startsWith(path.join(os.tmpdir(), 'flow-mcp-ui-')));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
