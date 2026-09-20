const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { keyFor } = require('../electron-main/hunyuan-model-watcher.cjs');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-workflow-notices-'));
    const data = path.join(profile, 'data');
    const output = path.join(__dirname, '../output/playwright');
    const accountId = randomUUID();
    const projectId = 'workflow-notices-smoke';
    const jobs = ['interrupted', 'awaiting_confirmation'].map(status => ({
        id: keyFor(randomUUID()), accountId, generationId: keyFor(randomUUID()), worksId: 'fixture',
        projectId, conversationId: 'external-workflows', status, createdAt: Date.now(), updatedAt: Date.now(),
        error: status === 'interrupted' ? 'Isolated interrupted workflow fixture' : '', dismissed: false
    }));
    let app;
    try {
        await fs.mkdir(data);
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(profile, 'workflow-smoke.marker'), 'isolated fixture');
        await fs.writeFile(path.join(profile, 'Rhino.exe'), 'fixture only');
        await fs.writeFile(path.join(data, 'board.json'), JSON.stringify({
            version: 1, activeGroupId: projectId, items: [], connections: [],
            folderGroups: [{ id: projectId, name: 'Workflow notices check', savedItems: [], connections: [], folders: [], boardRevision: 0 }],
            mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 }
        }));
        await fs.writeFile(path.join(data, 'hunyuan-rhino-jobs.json'), JSON.stringify({ version: 1, jobs }));
        await fs.writeFile(path.join(data, 'hunyuan-accounts.json'), JSON.stringify({ version: 1,
            accounts: [{ id: accountId, name: 'Workflow notices fixture', createdAt: new Date().toISOString() }] }));
        const env = { ...process.env, FLOW_WORKFLOW_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'workflow-smoke-entry.cjs')], env });
        let page;
        for (let attempt = 0; attempt < 150; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'Corvas canvas window was not created');
        await page.waitForSelector('#agentToggleBtn');
        const loaded = await page.evaluate(() => window.flowCanvas.hunyuan.workflowState());
        assert.deepEqual(loaded.jobs.map(job => job.id).sort(), jobs.map(job => job.id).sort());
        await app.evaluate(({ BrowserWindow }, state) => {
            const main = BrowserWindow.getAllWindows().find(window => /dist[\\/]index\.html/.test(window.webContents.getURL()));
            main.setSize(1280, 800);
            main.webContents.send('hunyuan:workflow-changed', state);
        }, { mode: 'ask', jobs });
        await page.waitForTimeout(1800);
        assert.equal(await page.locator('[aria-label="混元模型传递"]').count(), 0);
        assert.equal(await page.locator('.agent-hunyuan-workflow-card').count(), 0);
        assert.ok(!(await page.locator('body').innerText()).includes('模型整理已暂停'));
        assert.ok(!(await page.locator('body').innerText()).includes('模型已生成，发送到 Rhino 并整理？'));
        const screenshot = path.join(output, 'workflow-notices-removed.png');
        await page.screenshot({ path: screenshot });

        // Serve the exact Hunyuan origin from an isolated in-memory handler so
        // the old origin-gated preload would fail this check without any network.
        await app.evaluate(async ({ BrowserWindow, session }, preload) => {
            const isolated = session.fromPartition('workflow-notices-local-fixture');
            await isolated.protocol.handle('https', () => new Response(
                '<!doctype html><title>Local Hunyuan fixture</title><main id="fixture">Model workspace</main>'
                + '<button id="fixture-button" onclick="this.textContent=\'Clicked\'">Page action</button>',
                { headers: { 'content-type': 'text/html; charset=utf-8' } }
            ));
            const window = new BrowserWindow({ show: false, width: 900, height: 650,
                webPreferences: { session: isolated, preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
            await window.loadURL('https://3d.hunyuan.tencent.com/studio/creation/geo');
        }, path.join(__dirname, '../electron-main/hunyuan-studio-preload.cjs'));
        const studio = app.windows().find(window => window.url().startsWith('https://3d.hunyuan.tencent.com/'));
        assert.ok(studio, 'Local Hunyuan fixture window was not created');
        await studio.waitForSelector('#fixture-button');
        await app.evaluate(({ BrowserWindow }, state) => {
            BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('https://3d.hunyuan.tencent.com/'))
                .webContents.send('hunyuan:workflow-state', state);
        }, { mode: 'ask', jobs, currentModel: { ready: true, label: 'Fixture model', generationId: jobs[0].generationId, token: 'fixture-only' } });
        await studio.waitForTimeout(100);
        assert.deepEqual(await studio.locator('body > *').evaluateAll(elements => elements.map(element => element.id)), ['fixture', 'fixture-button']);
        assert.equal(await studio.locator('[aria-label="将当前模型导入到 Rhino"]').count(), 0);
        await studio.locator('#fixture-button').click();
        assert.equal(await studio.locator('#fixture-button').innerText(), 'Clicked');
        await assert.rejects(fs.access(path.join(profile, 'unexpected-provider-calls.log')), { code: 'ENOENT' });
        console.log(`Workflow notices smoke passed: persisted interrupted/pending jobs, no canvas workflow overlay, no sidebar workflow cards, no Hunyuan DOM injection, page interaction intact, zero provider calls. Screenshot: ${screenshot}`);
    } finally {
        await app?.close();
        const relative = path.relative(os.tmpdir(), profile);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
