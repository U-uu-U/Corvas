const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const results = [];
    for (const mode of ['source', 'packaged']) for (const delay of [0, 8500]) {
        const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-startup-'));
        let app;
        try {
            await fs.mkdir(path.join(profile, 'data'));
            await fs.mkdir(path.join(profile, 'data/asset-library'));
            const filePath = path.join(profile, 'data/asset-library/fixture.jpg');
            await sharp(path.join(__dirname, '../electron-main/assets/app-icon.png')).resize(640, 480, { fit: 'fill' }).jpeg().toFile(filePath);
            const items = Array.from({ length: 12 }, (_, i) => ({ id: `startup-${i}`, kind: 'media', mediaType: 'image', filePath,
                x: 40 + (i % 4) * 210, y: 90 + Math.floor(i / 4) * 170, width: 190, height: 142 }));
            await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'startup', items, connections: [],
                folderGroups: [{ id: 'startup', name: 'Startup fixture', folders: [], savedItems: items, connections: [] }],
                mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
            await fs.writeFile(path.join(profile, 'data/relay-browser.json'), JSON.stringify({ onboardingSkipped: true }));
            const env = { ...process.env, FLOW_STARTUP_SMOKE_PROFILE: profile, FLOW_STARTUP_SMOKE_MODE: mode, FLOW_STARTUP_SMOKE_DELAY: String(delay) };
            delete env.ELECTRON_RUN_AS_NODE;
            app = await electron.launch({ executablePath: require('electron'), args: ['--disable-gpu', path.join(__dirname, 'startup-smoke-entry.cjs')], env });
            let main, splash;
            for (let i = 0; i < 120; i++) {
                main = app.windows().find(page => page.url().includes('index.html') || page.url().startsWith('http://127.0.0.1:15321/'));
                splash = app.windows().find(page => page.url().includes('splash.html'));
                if (main && splash) break;
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            assert.ok(main && splash, 'Both splash and background canvas must start');
            assert.equal(await splash.locator('#splashVersion').textContent(), `v${require('../package.json').version}`);
            if (!delay) {
                await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
                await splash.screenshot({ path: path.join(__dirname, `../output/playwright/startup-${mode}-version.png`) });
            }
            for (let i = 0; i < 180; i++) {
                if (await app.evaluate(() => global.startupTrace.windows.some(window => window.shown && !window.url.includes('splash.html')))) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            const trace = await app.evaluate(() => global.startupTrace);
            const cover = trace.windows.find(window => window.url.includes('splash.html'));
            const canvas = trace.windows.find(window => !window.url.includes('splash.html') && window.shown);
            assert.ok(canvas?.shown && cover?.shown, 'Canvas must reveal within the bounded startup');
            const duration = canvas.shown - cover.shown;
            assert.ok(duration >= 1980 && duration <= 7350, `Splash duration ${duration}ms`);
            assert.ok(trace.loads.some(load => !load.mainVisible && load.splashVisible), 'Image loading must start behind the splash');
            if (!delay) {
                assert.ok(trace.loads.some(load => load.finished < canvas.shown), 'Images finish loading before the splash closes');
                assert.ok(duration < 6500, 'Fast startup need not wait seven seconds');
            } else {
                assert.ok(duration >= 6900, 'Slow images use the seven-second deadline');
                assert.equal(trace.loads.some(load => load.finished < canvas.shown), false);
            }
            await main.waitForFunction(() => window.Konva?.stages[0]?.find('Image').some(node => node.image()?.naturalWidth > 0), null, { timeout: 15000 });
            results.push({ mode, delayedImages: Boolean(delay), splashMs: duration, backgroundImageLoads: trace.loads.filter(load => !load.mainVisible).length });
        } catch (error) {
            if (app) console.error(JSON.stringify({ mode, delay, trace: await app.evaluate(() => global.startupTrace) }));
            throw error;
        } finally {
            await app?.close();
            await fs.rm(profile, { recursive: true, force: true });
        }
    }
    console.log(JSON.stringify({ ok: true, results }));
})().catch(error => { console.error(error); process.exitCode = 1; });
