const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-mcp-server-'));
    const output = path.join(__dirname, '../output/playwright');
    let app, clipboard;
    try {
        const port = await new Promise(resolve => {
            const server = net.createServer();
            server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
        });
        await fs.mkdir(path.join(profile, 'data'));
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, folderGroups: [], items: [],
            connections: [], mcp: { enabled: true, port } }));
        const env = { ...process.env, FLOW_MCP_SERVER_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        const launch = () => electron.launch({ executablePath: require('electron'),
            args: ['--disable-gpu', path.join(__dirname, 'mcp-server-smoke-entry.cjs')], env });
        const mainPage = async () => {
            for (let attempt = 0; attempt < 200; attempt++) {
                const page = app.windows().find(page => page.url().includes('index.html') || page.url().startsWith('http://127.0.0.1:15321/'));
                if (page) return page;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Canvas did not open');
        };
        app = await launch();
        clipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
        const page = await mainPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForSelector('#mcpServerSettings', { state: 'attached' });
        const notice = page.locator('#mcpStartupNotice');
        await page.waitForFunction(async () => (await window.flowCanvas.mcpServer.status()).windowVisible);
        let loginDeferred = false;
        if (await page.locator('#siteLoginDialog[open]').count()) {
            await page.waitForTimeout(1100);
            assert.equal(await notice.isVisible(), false);
            assert.equal(await notice.locator('[data-countdown]').textContent(), '20 秒');
            await page.locator('[data-login-skip]').click();
            loginDeferred = true;
        }
        await notice.waitFor({ state: 'visible' });
        const visibleAt = Date.now();
        const url = `http://127.0.0.1:${port}/mcp`;
        assert.equal(await notice.locator('[data-url]').textContent(), url);
        await notice.locator('[data-action=copy-url]').click();
        assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), url);
        await notice.locator('[data-action=copy]').click();
        const config = JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText()));
        assert.deepEqual(config, { mcpServers: { corvas: { type: 'http', url } } });
        const client = new Client({ name: 'harness-smoke', version: '1' });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(url)));
            assert.ok((await client.listTools()).tools.some(tool => tool.name === 'flow_canvas.board.get_snapshot'));
            assert.equal(JSON.parse((await client.callTool({ name: 'flow_canvas.health', arguments: {} })).content[0].text).mcp.port, port);
        } finally { await client.close(); }
        const mode = process.env.FLOW_SOURCE_SMOKE === '1' ? 'source' : 'built';
        await page.screenshot({ path: path.join(output, `mcp-startup-${mode}.png`) });
        await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('splash.html'));
            window.setMinimumSize(360, 600); window.setSize(420, 780);
        });
        await page.waitForTimeout(200);
        const fits = await notice.evaluate(root => {
            const bounds = root.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth && [...root.querySelectorAll('button, code, strong')]
                .every(el => {
                    const box = el.getBoundingClientRect();
                    return el.scrollWidth <= el.clientWidth + 1 && el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
                });
        });
        assert.ok(fits, 'Connection notice fits the narrow viewport');
        await page.screenshot({ path: path.join(output, `mcp-startup-${mode}-narrow.png`) });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 860));
        await notice.waitFor({ state: 'detached', timeout: 23000 });
        const visibleMs = Date.now() - visibleAt;
        assert.ok(visibleMs >= 19000 && visibleMs < 22000, `Notice visible for ${visibleMs}ms`);
        if (!await page.locator('#agentSettingsBtn').isVisible()) await page.locator('#agentToggleBtn').hover();
        await page.locator('#agentSettingsBtn').click();
        await page.locator('#agentCreationSettingsTab').click();
        const settings = page.locator('#agentCreationSettingsPane > #mcpServerSettings');
        await settings.waitFor({ state: 'visible' });
        await settings.locator('[data-action=toggle]').uncheck();
        await page.waitForFunction(async () => !(await window.flowCanvas.mcpServer.status()).running);
        assert.equal((await page.evaluate(() => window.flowCanvas.mcpServer.status())).boardToolsReady, true);
        await settings.screenshot({ path: path.join(output, `mcp-settings-${mode}.png`) });
        await app.close();
        app = await launch();
        const restarted = await mainPage();
        await restarted.waitForFunction(async () => window.flowCanvas?.mcpServer && !(await window.flowCanvas.mcpServer.status()).enabled);
        const stopped = await restarted.evaluate(() => window.flowCanvas.mcpServer.status());
        assert.equal(stopped.running, false);
        await restarted.locator('#mcpStartupNotice').waitFor({ state: 'visible' });
        await restarted.locator('#mcpStartupNotice [data-action=close]').click();
        assert.equal(await restarted.locator('#mcpStartupNotice').count(), 0);
        const running = await restarted.evaluate(() => window.flowCanvas.mcpServer.start());
        assert.equal(running.running, true);
        assert.equal(running.port, port);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ ok: true, mode, visibleMs, loginDeferred, clipboard: 'url and JSON verified', restart: 'passed' }));
    } finally {
        if (app) {
            if (clipboard !== undefined) await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboard).catch(() => {});
            await app.close();
        }
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
