const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-progress-profile-'));
    const media = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-progress-media-'));
    const fixture = path.join(media, 'fixture.mp4');
    let app, server, releaseDownload;
    let generationDone = false;
    let completedQueries = 0;
    let submissions = 0;
    let downloadRequests = 0;
    try {
        const encoded = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10',
            '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture], { encoding: 'utf8' });
        assert.equal(encoded.status, 0, encoded.stderr);
        const video = await fs.readFile(fixture);
        server = http.createServer((req, res) => {
            req.resume();
            if (new URL(req.url, 'http://fixture').pathname === '/output.mp4') {
                downloadRequests++;
                res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': video.length });
                const half = Math.floor(video.length / 2);
                const split = Math.floor(video.length * 0.75);
                res.write(video.subarray(0, half));
                const timer = setTimeout(() => {
                    res.write(video.subarray(half, split));
                    releaseDownload = () => res.end(video.subarray(split));
                }, 900);
                res.on('close', () => clearTimeout(timer));
                return;
            }
            res.setHeader('content-type', 'application/json');
            if (req.method === 'POST' && /\/v1\/(videos|video\/generations)$/.test(req.url)) {
                submissions++;
                res.end(JSON.stringify({ id: 'video-fixture', status: 'queued' })); return;
            }
            if (req.method === 'GET' && /\/video-fixture(?:\?|$)/.test(req.url)) {
                const status = generationDone ? 'completed' : 'in_progress';
                if (generationDone) completedQueries++;
                res.end(JSON.stringify({ id: 'video-fixture', status,
                    ...(completedQueries > 1 ? { video_url: `http://127.0.0.1:${server.address().port}/output.mp4?upstream_signature=private-fixture` } : {}) })); return;
            }
            res.statusCode = 404; res.end('{}');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const node = { id: 'video-node', kind: 'op', nodeType: 'video', x: 350, y: 120, width: 320, height: 180,
            config: { prompt: 'local video fixture', providerId: 'fixture', model: 'seedance_v2.5', duration: 4,
                ratio: '16:9', resolutionTier: '720p', count: 1 } };
        const boardPath = path.join(profile, 'data/board.json');
        await fs.mkdir(path.dirname(boardPath), { recursive: true });
        await fs.writeFile(boardPath, JSON.stringify({ activeGroupId: 'original', items: [node], connections: [],
            defaultSaveFolder: media, viewport: { x: 0, y: 0, scale: 1 }, mcp: { enabled: false },
            folderGroups: [{ id: 'original', name: 'Download check', folders: [media], defaultSaveFolder: media,
                savedItems: [node], connections: [], boardRevision: 0, removedFromBoardPathsInitialized: true }] }));
        const env = { ...process.env, FLOW_MEDIA_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'media-preview-smoke-entry.cjs')], env });
        let page;
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(candidate => /\/dist\/index\.html/.test(candidate.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', async message => {
            if (!message.text().includes('结果落地失败')) return;
            for (const value of message.args()) console.error(await value.evaluate(arg => arg?.stack || String(arg)));
        });
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#video-node'));
        await page.evaluate(async endpoint => {
            const providers = [{ id: 'fixture', name: 'Local video fixture', type: 'openai', capability: 'video',
                model: 'seedance_v2.5', models: ['seedance_v2.5'], endpoint, apiKey: 'fixture' }];
            await window.flowCanvas.apiConfig.save({ version: 1, revision: 100, providers, globalConfig: {} });
            localStorage.setItem('flow-canvas-agent-providers', JSON.stringify(providers));
            localStorage.setItem('flow-canvas-api-config-meta-v1', JSON.stringify({ version: 1, revision: 100 }));
        }, `http://127.0.0.1:${server.address().port}/v1`);
        await page.reload();
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#video-node'));
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('context-run-node', { detail: { nodeId: 'video-node' } })));
        await page.waitForFunction(() => /^\d+:\d+$/.test(window.Konva.stages[0].findOne('#video-node')?.findOne('.generationElapsed')?.text() || ''));
        generationDone = true;
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#video-node')?.findOne('.generationElapsed')?.text() === '正在下载...');
        assert.ok(completedQueries >= 1);
        assert.equal(downloadRequests, 0, 'timer must stop even before the final URL appears');
        await page.waitForFunction(() => /[KM]B/.test(window.Konva.stages[0].findOne('#video-node')?.findOne('.generationDownloadProgress')?.text() || ''));
        assert.equal(await page.evaluate(() => window.Konva.stages[0].findOne('#video-node').findOne('.generationElapsed').text()), '正在下载...');
        await page.locator('#agentTaskHistoryBtn').click();
        await page.waitForFunction(() => document.querySelector('#agentTaskHistoryList')?.textContent.includes('正在下载...'));
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/video-downloading.png') });
        assert.ok(releaseDownload);
        releaseDownload();
        for (let attempt = 0; attempt < 100; attempt++) {
            const board = JSON.parse(await fs.readFile(boardPath, 'utf8'));
            const result = board.items.find(item => item.id === 'video-node');
            if (result?.runError) throw new Error(result.runError);
            if (result?.resultFilePaths?.length) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const result = JSON.parse(await fs.readFile(boardPath, 'utf8')).items.find(item => item.id === 'video-node');
        assert.ok(result.resultFilePaths?.[0]);
        assert.deepEqual(await fs.readFile(result.resultFilePaths[0]), video);
        assert.doesNotMatch(await fs.readFile(boardPath, 'utf8'), /upstream_signature|private-fixture/);
        const taskHistory = await page.evaluate(() => localStorage.getItem('flow-canvas-generation-tasks'));
        assert.doesNotMatch(taskHistory || '', /upstream_signature|private-fixture/);
        const recoveryDir = path.join(profile, 'data/generation-recovery');
        for (const name of await fs.readdir(recoveryDir)) {
            if (name.endsWith('.json')) assert.doesNotMatch(await fs.readFile(path.join(recoveryDir, name), 'utf8'),
                /upstream_signature|private-fixture/);
        }
        assert.equal(submissions, 1);
        assert.equal(downloadRequests, 1);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ timerStopsAtRemoteCompletion: true, downloadProgress: true, landed: true,
            privateVideoUrlAbsent: true, submissions }));
    } finally {
        if (app) await app.close();
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        for (const [folder, prefix] of [[profile, 'corvas-progress-profile-'], [media, 'corvas-progress-media-']]) {
            assert.ok(folder.startsWith(path.join(os.tmpdir(), prefix)));
            await fs.rm(folder, { recursive: true, force: true });
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
