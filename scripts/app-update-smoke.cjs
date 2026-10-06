const path = require('node:path');
if (process.env.FLOW_UPDATE_SMOKE_ENTRY === '1' && process.versions.electron) {
    const { ipcMain, BrowserWindow } = require('electron');
    let state = { phase: 'idle', mode: 'automatic', currentVersion: '1.6.0-beta.13', latestVersion: null, notes: '', percent: 0, error: '' };
    let timer, finish;
    globalThis.updateSmoke = { downloads: 0, installs: 0, failNext: false };
    const publish = patch => {
        state = { ...state, ...patch };
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('app-updates:state', state);
        return state;
    };
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) => {
        if (!channel.startsWith('app-updates:')) return handle(channel, listener);
        handle(channel, async () => {
            const action = channel.split(':')[1];
            if (action === 'check') return publish({ phase: 'available', latestVersion: '1.6.0-beta.14', notes: '修复生成恢复\n优化模型选择', error: '' });
            if (action === 'download') {
                globalThis.updateSmoke.downloads++;
                publish({ phase: 'downloading', percent: 40 });
                return new Promise(resolve => {
                    finish = resolve;
                    timer = setTimeout(() => resolve(publish(globalThis.updateSmoke.failNext
                        ? { phase: 'error', error: '下载或校验失败，请重试。' } : { phase: 'downloaded', percent: 100 })), 700);
                });
            }
            if (action === 'cancel') { clearTimeout(timer); publish({ phase: 'available', percent: 0 }); finish?.(state); return state; }
            if (action === 'install') { globalThis.updateSmoke.installs++; return publish({ phase: 'installing' }); }
            return state;
        });
    };
    require('./api-catalog-smoke-entry.cjs');
} else {
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const http = require('node:http');
    const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    (async () => {
        const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-update-ui-'));
        let configRevision = 43, configOffline = false, configRequests = 0;
        const server = http.createServer((_req, res) => {
            configRequests++;
            res.setHeader('content-type', 'application/json');
            if (configOffline) { res.writeHead(503); res.end('{}'); return; }
            res.end(JSON.stringify({ schemaVersion: 1, revision: configRevision, catalogMode: 'remote', models: [] }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        let app;
        try {
            const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile, FLOW_UPDATE_SMOKE_ENTRY: '1',
                FLOW_API_CATALOG_SMOKE_URL: `http://127.0.0.1:${server.address().port}/config` };
            delete env.ELECTRON_RUN_AS_NODE;
            app = await electron.launch({ executablePath: require('electron'), args: ['--disable-gpu', __filename], env });
            let page;
            for (let i = 0; i < 100; i++) {
                page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
                if (page) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.ok(page);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            await page.waitForFunction(() => window.__flowCanvasGetModelConfigSnapshot?.().status.revision === 43);
            assert.ok(configRequests > 0);
            assert.equal(await app.evaluate(() => globalThis.updateSmoke.downloads), 0);
            await page.locator('#agentSettingsBtn').click();
            await page.getByRole('tab', { name: '软件更新' }).click();
            await page.waitForFunction(() => document.querySelector('#configUpdateVersion').textContent.includes('r43'));
            assert.match(await page.locator('#configUpdateAuto').innerText(), /启动自动同步.*10 秒/);
            configRevision = 44;
            await page.waitForFunction(() => document.querySelector('#configUpdateVersion').textContent.includes('r44'),
                null, { timeout: 15000 });
            configRevision = 45;
            await page.reload();
            await page.waitForFunction(() => window.__flowCanvasGetModelConfigSnapshot?.().status.revision === 45,
                null, { timeout: 7000 });
            await page.locator('#agentSettingsBtn').click();
            await page.getByRole('tab', { name: '软件更新' }).click();
            configOffline = true;
            await page.locator('#configUpdateAction').click();
            await page.waitForFunction(() => document.querySelector('#configUpdateStatus').textContent.includes('自动重试'));
            assert.match(await page.locator('#configUpdateVersion').innerText(), /r45/);
            configRevision = 46; configOffline = false;
            await page.evaluate(() => window.dispatchEvent(new Event('online')));
            await page.waitForFunction(() => document.querySelector('#configUpdateVersion').textContent.includes('r46'),
                null, { timeout: 7000 });
            configRevision = 47;
            await page.locator('#configUpdateAction').click();
            await page.waitForFunction(() => document.querySelector('#configUpdateVersion').textContent.includes('r47'));
            assert.equal(await app.evaluate(() => globalThis.updateSmoke.downloads), 0);
            assert.equal(await app.evaluate(() => globalThis.updateSmoke.installs), 0);
            const action = page.locator('#appUpdateAction');
            await action.click();
            await page.locator('#appUpdateProgress').waitFor();
            await page.locator('#appUpdateCancel').click();
            assert.match(await action.innerText(), /下载新版本/);
            await app.evaluate(() => { globalThis.updateSmoke.failNext = true; });
            await action.click();
            await page.waitForFunction(() => document.querySelector('#appUpdateStatus').textContent.includes('失败'));
            await app.evaluate(() => { globalThis.updateSmoke.failNext = false; });
            await action.click();
            await page.waitForFunction(() => document.querySelector('#appUpdateAction').textContent.includes('重启并安装'));
            await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
            for (const [name, width, height] of [['desktop', 1440, 1000], ['compact', 820, 760]]) {
                await app.evaluate(({ BrowserWindow }, dimensions) => {
                    BrowserWindow.getAllWindows().find(window => /index\.html/.test(window.webContents.getURL())).setContentSize(...dimensions);
                }, [width, height]);
                assert.equal(await page.locator('#agentUpdateSettingsPane').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
                await page.screenshot({ path: path.join(__dirname, `../output/playwright/app-update-${name}.png`) });
            }
            await action.click();
            assert.equal(await app.evaluate(() => globalThis.updateSmoke.installs), 1);
            assert.deepEqual(errors, []);
            console.log('PASS update settings: CONFIG startup, polling, fresh-cache relaunch, offline cache, reconnect and manual sync; software check, progress, cancellation, retry, saved-board install action, desktop/compact. No real install.');
        } finally { await app?.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(profile, { recursive: true, force: true }); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
}
