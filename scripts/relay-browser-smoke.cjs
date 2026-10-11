const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-relay-smoke-'));
    let app;
    const servers = [], queries = [];
    let downloadCount = 0, mutations = 0;
    const accountKeys = { ai: [], art: [], cart: [] };
    try {
        const fixture = path.join(profile, 'fixture.mp4');
        const encoded = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10',
            '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture], { encoding: 'utf8' });
        assert.equal(encoded.status, 0, encoded.stderr);
        const bytes = await fs.readFile(fixture);
        for (const site of ['ai', 'art', 'cart']) {
            const server = http.createServer((req, res) => {
                const url = new URL(req.url, 'http://fixture');
                if (req.method !== 'GET') mutations++;
                if (site === 'ai' && url.pathname.startsWith('/api/')) {
                    res.setHeader('content-type', 'application/json');
                    if (req.headers.authorization !== 'Bearer ai-fixture') { res.statusCode = 401; res.end('{}'); return; }
                    if (url.pathname === '/api/user/self') { res.end(JSON.stringify({ success: true, data: { id: 1, username: 'Image User', status: 1 } })); return; }
                    if (url.pathname === '/api/token/1/key') { res.end(JSON.stringify({ success: true, data: { key: 'aiFixtureOnly123' } })); return; }
                    if (req.method === 'POST' && url.pathname === '/api/token/') {
                        accountKeys.ai.push({ id: 1, name: 'Corvas Canvas', status: 1, expired_time: -1 });
                        res.end(JSON.stringify({ success: true })); return;
                    }
                    res.end(JSON.stringify({ success: true, data: { items: accountKeys.ai, total: accountKeys.ai.length } })); return;
                }
                if (url.pathname === '/api/v1/user/profile' || url.pathname === '/api/v1/tokens') {
                    res.setHeader('content-type', 'application/json');
                    if (req.headers.authorization !== `Bearer ${site}-fixture`) { res.statusCode = 401; res.end('{}'); return; }
                    if (url.pathname.endsWith('/profile')) {
                        res.end(JSON.stringify({ id: 'user1', username: `${site} User`, is_active: 1 })); return;
                    }
                    if (req.method === 'POST') {
                        const token = { id: 1, user_id: 'user1', name: 'Corvas Canvas', is_active: 1, token_key: `sk-${site}FixtureOnly123` };
                        accountKeys[site].push(token); res.end(JSON.stringify(token)); return;
                    }
                    res.end(JSON.stringify({ data: accountKeys[site] })); return;
                }
                if (url.pathname === '/video.mp4') {
                    downloadCount++; res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length }); res.end(bytes); return;
                }
                if (url.pathname === '/api/v1/task_logs') {
                    queries.push({ site, query: url.search });
                    res.setHeader('content-type', 'application/json');
                    if (req.headers.authorization !== `Bearer ${site}-fixture`) { res.statusCode = 401; res.end('{}'); return; }
                    res.end(JSON.stringify({ data: [{ log_id: 'log1', task_id: 'task1', user_id: 'user1', model: 'fixture', is_completed: 1,
                        preview_urls: [`http://127.0.0.1:${server.address().port}/video.mp4?signature=private`] }], total: 1 })); return;
                }
                res.setHeader('content-type', 'text/html; charset=utf-8');
                res.end(`<html><body style="background:#fff;color:#222;font:16px sans-serif;padding:40px"><h1>${site} 原站页面</h1>
                    <button id="login" onclick="${site === 'ai' ? "document.cookie='imageLoggedIn=1;path=/;max-age=86400';" : `localStorage.setItem('token','${site}-fixture');`}location.href='/dashboard'">登录</button>
                    <a id="download" href="/video.mp4?signature=private" download="result.mp4">下载视频</a>
                    <script>if('${site}'==='ai'&&document.cookie.includes('imageLoggedIn=1')) fetch('/api/user/self',{headers:{Authorization:'Bearer ai-fixture'}});if(location.pathname==='/task-logs') fetch('/api/v1/task_logs?page=1&per_page=20&start_date=2026-10-07&end_date=2026-10-07',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).then(r=>r.json()).then(()=>document.body.dataset.ready='yes')</script>
                    </body></html>`);
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
        }
        const node = { id: 'node1', kind: 'op', nodeType: 'video', config: { prompt: 'original' }, width: 320, height: 180 };
        await fs.writeFile(path.join(profile, 'board.json'), JSON.stringify({ activeGroupId: 'current', items: [], connections: [],
            folderGroups: [{ id: 'original', savedItems: [node], connections: [] }, { id: 'current', savedItems: [], connections: [] }] }));
        const env = { ...process.env, RELAY_SMOKE_PROFILE: profile,
            RELAY_SMOKE_AI: `http://127.0.0.1:${servers[0].address().port}`,
            RELAY_SMOKE_ART: `http://127.0.0.1:${servers[1].address().port}`, RELAY_SMOKE_CART: `http://127.0.0.1:${servers[2].address().port}` };
        delete env.ELECTRON_RUN_AS_NODE;
        const launch = () => electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'relay-browser-smoke-entry.cjs')], env });
        app = await launch();
        const page = await app.firstWindow();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.locator('[data-site="art"]').waitFor();
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/relay-picker.png') });
        assert.equal(await page.locator('#records, #panel').count(), 0, 'no duplicate station task UI');
        const inSite = async (site, script) => app.evaluate(async (_electron, { site, script }) => {
            const web = global.relaySmoke.views.get(site).webContents;
            if (web.isLoading()) await new Promise(resolve => web.once('did-finish-load', resolve));
            return web.executeJavaScript(script);
        }, { site, script });
        for (const site of ['ai', 'art', 'cart']) {
            if (site !== 'ai') await page.locator('#switch').click();
            await page.locator(`[data-site="${site}"]`).click();
            await inSite(site, "document.getElementById('login').click()");
            await page.locator('#connect[data-state="connected"]').waitFor();
            await page.locator('#connect').click();
            await page.locator('#connect[data-state="connected"]').waitFor();
            assert.equal(accountKeys[site].length, 1, 'Reconnection must reuse the dedicated key');
            if (site === 'ai') {
                assert.equal(await inSite(site, "localStorage.getItem('token')"), null, 'New API authentication comes from its own HTTP session');
                continue;
            }
            await page.locator('#logs').click();
            await inSite(site, "document.getElementById('download').click()");
            await page.getByText('视频已导入画布', { exact: true }).waitFor();
            assert.equal(await inSite(site, 'typeof window.relayBrowser'), 'undefined');
            const board = JSON.parse(await fs.readFile(path.join(profile, 'board.json')));
            assert.equal(board.folderGroups[0].savedItems.length, 1);
            assert.ok(board.folderGroups[0].savedItems[0].filePath);
            assert.equal(board.folderGroups[1].savedItems.length, site === 'art' ? 0 : 1);
            assert.doesNotMatch(JSON.stringify(board), /private|signature|preview_urls/);
        }
        await app.evaluate(() => global.relaySmoke.open({ site: 'art', taskId: 'task1', clientTaskId: 'original-task' }));
        await page.locator('#task-label').filter({ hasText: 'task1' }).waitFor();
        await inSite('art', 'document.body.textContent');
        for (let i = 0; i < 50 && !queries.some(entry => entry.query.includes('task_id=task1')); i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(queries.some(entry => entry.site === 'art' && entry.query.includes('task_id=task1') && !entry.query.includes('start_date')), JSON.stringify(queries));
        await inSite('art', "document.getElementById('download').click()");
        await page.getByText('视频已导入画布', { exact: true }).waitFor();
        const board = JSON.parse(await fs.readFile(path.join(profile, 'board.json')));
        assert.equal(board.folderGroups[0].savedItems.length, 1);
        await app.evaluate(() => global.relaySmoke.window.setContentSize(640, 600));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const view = await app.evaluate(async () => {
            const browser = global.relaySmoke, view = browser.views.get('art');
            return { bounds: view.getBounds(), width: browser.window.getContentSize()[0],
                png: (await view.webContents.capturePage()).toPNG().toString('base64') };
        });
        assert.equal(view.bounds.width, view.width, 'station page retains the full browser width');
        await fs.writeFile(path.join(__dirname, '../output/playwright/relay-original-site.png'), Buffer.from(view.png, 'base64'));
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/relay-connected-toolbar.png') });
        await page.locator('#clear-task').click();
        assert.equal(await page.locator('#clear-task').isVisible(), false);
        assert.deepEqual(await app.evaluate(() => global.relayRevealed), []);
        const reopenedPromise = app.waitForEvent('window');
        await app.evaluate(async () => {
            const window = global.relaySmoke.window;
            await new Promise(resolve => { window.once('closed', resolve); window.close(); });
            await global.relaySmoke.open({ site: 'ai' });
        });
        const reopened = await reopenedPromise;
        await reopened.locator('#connect[data-state="connected"]').waitFor();
        assert.equal(accountKeys.ai.length, 1, 'Saved image login is reused after closing the browser');
        assert.equal(Object.values(accountKeys).reduce((count, keys) => count + keys.length, 0), 3);
        const linked = await app.evaluate(() => global.relayAccountStore.load().config.providers);
        assert.equal(linked.length, 3);
        assert.equal(linked[0].endpoint, 'https://ai.ravenhash.org/v1');
        assert.equal(linked[0].capability, 'image');
        assert.equal(linked[1].endpoint, 'https://art.ravenhash.org/v1');
        assert.equal(linked[2].endpoint, 'https://cart.ravenhash.org/v1');
        const encrypted = await fs.readFile(path.join(profile, 'data/api-config.v1.json'), 'utf8');
        assert.equal(JSON.parse(encrypted).format, 'safe-storage');
        assert.doesNotMatch(encrypted, /FixtureOnly123|art-fixture|cart-fixture/);
        await app.close();
        app = await launch();
        const restarted = await app.firstWindow();
        await restarted.locator('#connect[data-state="connected"]').waitFor();
        assert.equal(await app.evaluate(() => global.relaySmoke.site), 'ai');
        assert.equal(accountKeys.ai.length, 1, 'Application restart restores the saved session without creating another key');
        await restarted.locator('#switch').click();
        await restarted.locator('[data-site="art"]').click();
        await restarted.locator('#connect[data-state="connected"]').waitFor();
        assert.equal(accountKeys.art.length, 1, 'Video login storage also survives application restart');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ ok: true, downloadCount, mutations, originalSiteUI: true, originalNodeRestored: true, separateSites: true }));
    } finally {
        await app?.close();
        for (const server of servers) await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
