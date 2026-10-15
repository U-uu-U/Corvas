const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { mediaToolPaths } = require('../electron-main/media-processor.cjs');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-media-tool-'));
    const assets = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-media-fixtures-'));
    let app, page;
    const errors = [];
    const boardFile = path.join(profile, 'data/board.json');
    const readBoard = async () => JSON.parse(await fs.readFile(boardFile, 'utf8'));
    try {
        const image = path.join(assets, 'reference.png');
        const audio = path.join(assets, 'sample.wav');
        const video = path.join(assets, 'sample.mp4');
        await sharp({ create: { width: 480, height: 320, channels: 3, background: '#559b8b' } }).jpeg().toFile(image);
        const tools = mediaToolPaths();
        execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000', '-t', '3', audio], { windowsHide: true });
        execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi',
            '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video], { windowsHide: true });
        const items = [
            { id: 'source-image', kind: 'media', filePath: image, mediaType: 'image', x: 500, y: 80, width: 220, height: 147 },
            { id: 'source-audio', kind: 'media', filePath: audio, mediaType: 'audio', x: 500, y: 280, width: 220, height: 120 },
            { id: 'source-video', kind: 'media', filePath: video, mediaType: 'video', x: 760, y: 80, width: 220, height: 124 },
            { id: 'generator', kind: 'op', nodeType: 'video', x: 800, y: 300, width: 220, height: 160, config: { prompt: 'fixture' } }
        ];
        const connection = { id: 'source-link', from: { nodeId: 'source-image', port: 'out' }, to: { nodeId: 'generator', port: 'source' } };
        await fs.mkdir(path.dirname(boardFile));
        await fs.writeFile(path.join(profile, 'data/relay-browser.json'), JSON.stringify({ onboardingSkipped: true }));
        await fs.writeFile(boardFile, JSON.stringify({ activeGroupId: 'a', items, connections: [connection],
            viewport: { x: 0, y: 0, scale: 1 }, watchFolders: [assets], removedFromBoardPaths: [], removedFromBoardPathsInitialized: true,
            folderGroups: [
                { id: 'a', name: 'Media test', folders: [assets], savedItems: items, connections: [connection], removedFromBoardPaths: [], removedFromBoardPathsInitialized: true },
                { id: 'b', name: 'Other board', folders: [], savedItems: [], connections: [], removedFromBoardPaths: [], removedFromBoardPathsInitialized: true }
            ], mcp: { enabled: false } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile, FLOW_SOURCE_SMOKE: '1' };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(candidate => candidate.url().startsWith('http://127.0.0.1:15321/'));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#source-image') && window.flowCanvas.mediaProcess);
        await page.locator('#siteLoginDialog[open] [data-login-skip]').click();
        const selectNode = async id => page.evaluate(id => {
            const node = window.Konva.stages[0].findOne('#'+id);
            node.fire('click', { evt: { button: 0, ctrlKey: false, metaKey: false, shiftKey: false } });
        }, id);
        await selectNode('source-image');
        await page.getByRole('button', { name: '素材处理', exact: true }).click();
        const panel = page.locator('#mediaProcessingPanel');
        await panel.locator('form').waitFor({ state: 'visible' });
        assert.ok((await panel.locator('[data-meta]').innerText()).includes('JPEG'));
        await panel.getByLabel('输出格式', { exact: true }).selectOption('png');
        await panel.getByLabel('输出宽度', { exact: true }).fill('240');
        await panel.getByLabel('替换当前素材', { exact: true }).check();
        await panel.getByRole('button', { name: '开始处理', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#mediaProcessingPanel [role=status]').textContent.includes('已替换当前素材'));
        let board = await readBoard();
        const replaced = board.items.find(item => item.id === 'source-image');
        assert.notEqual(replaced.filePath, image);
        assert.ok(board.connections.some(edge => edge.id === connection.id && edge.from.nodeId === 'source-image' && edge.to.nodeId === 'generator'));
        const meta = await sharp(replaced.filePath).metadata();
        assert.equal(meta.format, 'png'); assert.equal(meta.width, 240);
        assert.equal((await sharp(image).metadata()).format, 'jpeg');
        await panel.getByLabel('输出宽度', { exact: true }).fill('120');
        await panel.getByRole('button', { name: '开始处理', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#mediaProcessingPanel [role=status]').textContent.includes('已替换当前素材')
            && !document.querySelector('#mediaProcessingPanel [type=submit]').disabled);
        board = await readBoard();
        const replacedAgain = board.items.find(item => item.id === 'source-image');
        assert.notEqual(replacedAgain.filePath, replaced.filePath);
        assert.equal((await sharp(replacedAgain.filePath).metadata()).width, 120);
        assert.equal(board.connections.find(edge => edge.id === connection.id).from.nodeId, 'source-image');

        await panel.getByRole('button', { name: '关闭素材处理' }).click();
        await page.evaluate(() => {
            const node = window.Konva.stages[0].findOne('#source-audio');
            node.fire('contextmenu', { evt: { preventDefault() {}, clientX: 520, clientY: 380, button: 2 } });
        });
        await page.locator('#contextMenu [data-action=processMedia]').click();
        await panel.getByLabel('输出格式', { exact: true }).waitFor({ state: 'visible' });
        await panel.getByLabel('开始时间', { exact: true }).fill('0.5');
        await panel.getByLabel('结束时间', { exact: true }).fill('1.5');
        await panel.getByRole('button', { name: '开始处理', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#mediaProcessingPanel [role=status]').textContent.includes('已添加副本'));
        board = await readBoard();
        const mp3 = board.items.find(item => item.filePath?.endsWith('.mp3'));
        assert.ok(mp3);
        const audioInfo = await page.evaluate(file => window.flowCanvas.mediaProcess.inspect(file), mp3.filePath);
        assert.equal(audioInfo.audioCodec, 'mp3');
        assert.ok(Math.abs(audioInfo.duration-1) < 0.1);

        await panel.getByRole('button', { name: '关闭素材处理' }).click();
        await selectNode('source-video');
        await page.getByRole('button', { name: '素材处理', exact: true }).click();
        await panel.getByRole('button', { name: '使用选中素材', exact: true }).click();
        await panel.locator('[data-video-options]').waitFor({ state: 'visible' });
        await panel.getByLabel('结束时间', { exact: true }).fill('1');
        await panel.getByRole('button', { name: '开始处理', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#mediaProcessingPanel [role=status]').textContent.includes('已添加副本'));
        await panel.locator('video').evaluate(video => new Promise(resolve => { if (video.readyState >= 2) resolve(); else video.addEventListener('loadeddata', resolve, { once: true }); }));
        await panel.locator('video').evaluate(video => video.play());
        await page.waitForFunction(() => document.querySelector('#mediaProcessingPanel video')?.currentTime > 0.1);
        await panel.locator('video').evaluate(video => video.pause());
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        for (const [theme, width, height] of [['dark', 1400, 900], ['light', 1400, 900], ['dark', 430, 820]]) {
            await page.setViewportSize({ width, height });
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.dispatchEvent(new Event('resize')); }, theme);
            await page.waitForTimeout(120);
            assert.ok(await panel.evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && element.scrollWidth <= element.clientWidth; }));
            await page.screenshot({ path: path.join(__dirname, `../output/playwright/media-processing-${theme}-${width}.png`) });
        }
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.evaluate(() => {
            document.querySelector('#mediaProcessingPanel form').requestSubmit();
            document.querySelector('[data-group-id="b"] .group-header').click();
        });
        await page.waitForFunction(() => document.querySelector('#mediaProcessingPanel [role=status]').textContent.includes('原画布已切换'));
        board = await readBoard();
        assert.equal(board.activeGroupId, 'b');
        assert.equal(board.items.length, 0);
        await panel.getByRole('button', { name: '添加到当前画布' }).click();
        await page.waitForFunction(() => document.querySelector('#mediaProcessingPanel [role=status]').textContent === '已添加到当前画布');
        assert.equal((await readBoard()).items.length, 1);
        assert.deepEqual(errors, []);
        console.log('PASS media tool: toolbar/context menu, image replacement preserves links, MP3 trim, MP4 conversion, cross-project guard, dark/light/narrow layouts.');
    } catch (error) {
        if (page && !page.isClosed()) {
            await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
            await page.screenshot({ path: path.join(__dirname, '../output/playwright/media-processing-error.png') });
            console.error(JSON.stringify({ errors, panel: await page.locator('#mediaProcessingPanel').innerText().catch(() => '') }));
        }
        throw error;
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
        await fs.rm(assets, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
