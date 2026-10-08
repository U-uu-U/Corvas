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
    try {
        const fixture = path.join(profile, 'fixture.mp4');
        const encoded = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10',
            '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture], { encoding: 'utf8' });
        assert.equal(encoded.status, 0, encoded.stderr);
        const bytes = await fs.readFile(fixture);
        for (const site of ['art', 'cart']) {
            const server = http.createServer((req, res) => {
                const url = new URL(req.url, 'http://fixture');
                if (req.method !== 'GET') mutations++;
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
                    <button id="login" onclick="localStorage.setItem('token','${site}-fixture');location.href='/dashboard'">登录</button>
                    <a id="download" href="/video.mp4?signature=private" download="result.mp4">下载视频</a>
                    <script>if(location.pathname==='/task-logs') fetch('/api/v1/task_logs?page=1&per_page=20&start_date=2026-10-07&end_date=2026-10-07',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).then(r=>r.json()).then(()=>document.body.dataset.ready='yes')</script>
                    </body></html>`);
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
        }
        const node = { id: 'node1', kind: 'op', nodeType: 'video', config: { prompt: 'original' }, width: 320, height: 180 };
        await fs.writeFile(path.join(profile, 'board.json'), JSON.stringify({ activeGroupId: 'current', items: [], connections: [],
            folderGroups: [{ id: 'original', savedItems: [node], connections: [] }, { id: 'current', savedItems: [], connections: [] }] }));
        const env = { ...process.env, RELAY_SMOKE_PROFILE: profile,
            RELAY_SMOKE_ART: `http://127.0.0.1:${servers[0].address().port}`, RELAY_SMOKE_CART: `http://127.0.0.1:${servers[1].address().port}` };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'relay-browser-smoke-entry.cjs')], env });
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
        for (const site of ['art', 'cart']) {
            if (site === 'cart') await page.locator('#switch').click();
            await page.locator(`[data-site="${site}"]`).click();
            await inSite(site, "document.getElementById('login').click()");
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
        await page.locator('#clear-task').click();
        assert.equal(await page.locator('#clear-task').isVisible(), false);
        assert.deepEqual(await app.evaluate(() => global.relayRevealed), []);
        assert.equal(mutations, 0);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ ok: true, downloadCount, mutations, originalSiteUI: true, originalNodeRestored: true, separateSites: true }));
    } finally {
        await app?.close();
        for (const server of servers) await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
