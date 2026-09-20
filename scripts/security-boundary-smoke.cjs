const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-security-smoke-'));
    const media = path.join(profile, 'data', 'captured');
    let app;
    try {
        await fs.mkdir(media, { recursive: true });
        const file = path.join(media, 'image.png');
        const executable = path.join(media, 'do-not-run.cmd');
        const videoFile = path.join(media, 'video.mp4');
        await sharp({ create: { width: 80, height: 60, channels: 3, background: '#608090' } }).png().toFile(file);
        await fs.writeFile(executable, 'This fixture must never execute.');
        execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
            'color=c=gray:s=160x90:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoFile]);
        await fs.writeFile(path.join(profile, 'secret.txt'), 'private-fixture');
        const items = [{ id: 'security-image', kind: 'media', mediaType: 'image', filePath: file, x: 100, y: 100, width: 160, height: 120 }];
        await fs.writeFile(path.join(profile, 'data', 'board.json'), JSON.stringify({ version: 1, activeGroupId: 'security', items,
            folderGroups: [{ id: 'security', name: 'Security verification', savedItems: items, folders: [], connections: [] }],
            mcp: { enabled: false } }));
        await fs.writeFile(path.join(profile, 'fixture-api.json'), JSON.stringify({ revision: 1, providers: [], globalConfig: {} }));
        const env = { ...process.env, FLOW_CANVAS_SMOKE_PROFILE: profile, FLOW_CANVAS_SMOKE_ASAR: path.resolve(__dirname, '..') };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'agent-smoke-entry.cjs')], env });
        let page;
        for (let i = 0; i < 100; i++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'Main window created');
        await page.waitForFunction(() => window.flowCanvas?.shell && window.Konva?.stages[0]?.findOne('#security-image')?.findOne('.displayNode'));
        const preferences = await app.evaluate(({ BrowserWindow, shell }) => {
            // Verify dispatch without opening the OS image viewer or executing any fixture.
            globalThis.securityOpenCalls = [];
            shell.openPath = async file => { globalThis.securityOpenCalls.push(file); return ''; };
            return BrowserWindow.getAllWindows().find(window => /dist[\\/]index\.html/.test(window.webContents.getURL())).webContents.getLastWebPreferences();
        });
        assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true);
        const result = await page.evaluate(async ({ file, executable, profile, videoFile }) => {
            const url = path => 'local-res://' + encodeURIComponent(path);
            const image = await fetch(url(file));
            const imageBytes = (await image.arrayBuffer()).byteLength;
            const range = await fetch(url(file), { headers: { range: 'bytes=0-7' } });
            const rangeBytes = (await range.arrayBuffer()).byteLength;
            const secret = await fetch(url(profile + '/secret.txt'));
            const credentials = await fetch(url(profile + '/data/api-config.v1.json'));
            let denied = false;
            try { await window.flowCanvas.shell.openFile(executable); } catch { denied = true; }
            await window.flowCanvas.shell.openFile(file);
            const exported = await new Promise((resolve, reject) => {
                const preview = new Image(); preview.crossOrigin = 'anonymous';
                preview.onload = () => {
                    try { const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60;
                        canvas.getContext('2d').drawImage(preview, 0, 0); resolve(canvas.toDataURL()); } catch (error) { reject(error); }
                };
                preview.onerror = () => reject(new Error('Authorized image did not load'));
                preview.src = url(file);
            });
            const privateDownload = await window.flowCanvas.image.downloadFromUrl('http://127.0.0.1:9/forbidden.png');
            const videoFrame = await new Promise((resolve, reject) => {
                const video = document.createElement('video'); video.muted = true; video.crossOrigin = 'anonymous';
                video.onloadeddata = () => { video.currentTime = 0.5; };
                video.onseeked = () => {
                    try { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
                        canvas.getContext('2d').drawImage(video, 0, 0); resolve(canvas.toDataURL()); } catch (error) { reject(error); }
                    video.removeAttribute('src'); video.load();
                };
                video.onerror = () => reject(new Error('Authorized video did not load'));
                video.src = url(videoFile);
            });
            return { imageStatus: image.status, imageBytes, rangeStatus: range.status, rangeBytes,
                secretStatus: secret.status, credentialStatus: credentials.status, denied, exported,
                privateDownload, videoFrame, nodeType: typeof require };
        }, { file, executable, profile, videoFile });
        assert.equal(result.imageStatus, 200); assert.ok(result.imageBytes > 0);
        assert.equal(result.rangeStatus, 206); assert.equal(result.rangeBytes, 8);
        assert.equal(result.secretStatus, 404); assert.equal(result.credentialStatus, 404);
        assert.equal(result.denied, true); assert.match(result.exported, /^data:image\/png/);
        assert.match(result.videoFrame, /^data:image\/png/);
        assert.equal(result.privateDownload.success, false); assert.match(result.privateDownload.error, /内网/);
        assert.equal(result.nodeType, 'undefined');
        assert.deepEqual(await app.evaluate(() => globalThis.securityOpenCalls), [file]);
        await page.evaluate(() => window.flowCanvas.win.collapseToOrb());
        const orb = app.windows().find(window => /orb\.html/.test(window.url())) || await app.waitForEvent('window');
        await orb.locator('#orbButton').waitFor();
        assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
            .find(window => /orb\.html/.test(window.webContents.getURL())).webContents.getLastWebPreferences().sandbox), true);
        await orb.locator('#orbButton').click();
        console.log('Security boundary smoke passed: main/orb sandbox and preload, authorized image/video/seek, canvas export, credential denial, executable denial, safe shell dispatch and private URL denial.');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
