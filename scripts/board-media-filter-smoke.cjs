const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-startup-media-filter-'));
    const folder = path.join(profile, 'data', 'asset-library');
    const boardFile = path.join(profile, 'data/board.json');
    let app;
    const errors = [];
    const read = async () => JSON.parse(await fs.readFile(boardFile, 'utf8'));
    const launch = async () => {
        const env = { ...process.env, FLOW_STARTUP_SMOKE_PROFILE: profile,
            FLOW_STARTUP_SMOKE_MODE: process.env.FLOW_SOURCE_SMOKE === '1' ? 'source' : 'packaged' };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: ['--disable-gpu', path.join(__dirname, 'startup-smoke-entry.cjs')], env });
        let page;
        for (let attempt = 0; attempt < 150; attempt++) {
            page = app.windows().find(page => page.url().includes('index.html') || page.url().startsWith('http://127.0.0.1:15321/'));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(page);
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#generator'));
        await page.waitForFunction(async () => (await window.flowCanvas.mcpServer.status()).windowVisible);
        await page.locator('#siteLoginDialog[open] [data-login-skip]').click();
        const popup = page.locator('#mcpStartupNotice [data-action=close]');
        if (await popup.isVisible()) await popup.click();
        return page;
    };
    const waitForStored = async predicate => {
        for (let attempt = 0; attempt < 120; attempt++) {
            const value = await read();
            if (predicate(value)) return value;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Board did not converge: ${JSON.stringify((await read()).items)}`);
    };
    try {
        await fs.mkdir(path.dirname(boardFile));
        await fs.mkdir(folder);
        const good = path.join(folder, '_real.png');
        const hidden = path.join(folder, 'user-removed.png');
        const png = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#508f78' } }).png().toBuffer();
        await fs.writeFile(good, png);
        await fs.writeFile(hidden, png);
        await fs.writeFile(path.join(folder, 'deck.pptx'), 'fixture document');
        await fs.writeFile(path.join(folder, 'page.html'), '<html></html>');
        await fs.writeFile(path.join(folder, '~$deck.pptx'), 'lock');
        await fs.writeFile(path.join(folder, 'empty.png'), '');
        const items = [
            { id: 'good', filePath: good, x: 20, y: 100, width: 160, height: 120 },
            { id: 'missing', filePath: path.join(folder, '_a1.png'), x: 200, y: 100 },
            { id: 'slides', filePath: path.join(folder, 'deck.pptx'), x: 400, y: 100 },
            { id: 'empty', filePath: path.join(folder, 'empty.png'), x: 600, y: 100 },
            { id: 'note', kind: 'op', nodeType: 'text', config: { text: 'Keep this note' }, x: 20, y: 400 },
            { id: 'generator', kind: 'op', nodeType: 'image', config: {}, x: 280, y: 400 }
        ];
        const groupB = [{ id: 'slides-b', filePath: path.join(folder, 'deck.pptx'), x: 20, y: 100 },
            { id: 'missing-b', filePath: path.join(folder, '_b1.png'), x: 200, y: 100 }];
        const connections = [{ id: 'stale-edge', from: { nodeId: 'missing', port: 'out' }, to: { nodeId: 'generator', port: 'image' } }];
        await fs.writeFile(boardFile, JSON.stringify({ activeGroupId: 'a', items, connections, watchFolders: [folder],
            viewport: { x: 0, y: 0, scale: 1 }, removedFromBoardPaths: [hidden], removedFromBoardPathsInitialized: true,
            folderGroups: [
                { id: 'a', name: 'Media filter', folders: [folder], savedItems: items, connections,
                    removedFromBoardPaths: [hidden], removedFromBoardPathsInitialized: true },
                { id: 'b', name: 'Switch cleanup', folders: [folder], savedItems: groupB, connections: [],
                    removedFromBoardPaths: [good, hidden], removedFromBoardPathsInitialized: true }
            ], mcp: { enabled: false } }));
        await fs.writeFile(path.join(profile, 'data/relay-browser.json'), JSON.stringify({ onboardingSkipped: true }));
        let page = await launch();
        let stored = await waitForStored(data => data.items.length === 3);
        assert.deepEqual(stored.items.map(item => item.id).sort(), ['generator', 'good', 'note']);
        assert.deepEqual(stored.connections, []);
        assert.equal(await page.evaluate(() => window.Konva.stages[0].findOne('#missing') != null), false);
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#good')?.findOne('.displayNode'));
        await page.locator('[data-group-id=b] .group-header').click();
        await waitForStored(data => data.activeGroupId === 'b' && data.items.length === 0);
        await page.locator('[data-group-id=a] .group-header').click();
        await waitForStored(data => data.activeGroupId === 'a' && data.items.length === 3);
        const newFile = path.join(folder, 'new.png');
        await fs.writeFile(path.join(folder, 'new.pptx'), 'new document');
        await fs.writeFile(newFile, png);
        stored = await waitForStored(data => data.items.some(item => item.filePath === newFile));
        assert.equal(stored.items.some(item => /\.pptx$/i.test(item.filePath || '')), false);
        await fs.unlink(good);
        await waitForStored(data => !data.items.some(item => item.id === 'good'));
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, `../output/playwright/board-media-filter-${process.env.FLOW_SOURCE_SMOKE === '1' ? 'source' : 'built'}.png`) });
        await app.close(); app = null;
        page = await launch();
        stored = await read();
        assert.deepEqual(stored.items.filter(item => item.kind === 'op').map(item => item.id).sort(), ['generator', 'note']);
        assert.equal(stored.items.filter(item => item.filePath).length, 1);
        assert.equal(stored.items.find(item => item.filePath)?.filePath, newFile);
        assert.ok(stored.removedFromBoardPaths.some(file => /user-removed\.png$/.test(file)));
        await fs.access(path.join(folder, 'deck.pptx'));
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ ok: true, startup: 'filtered', switch: 'filtered', realtime: 'media only',
            restart: 'persisted', notesAndGenerators: 'preserved', sourceFiles: 'preserved' }));
    } catch (error) {
        const page = app?.windows().find(page => page.url().includes('index.html') || page.url().startsWith('http://127.0.0.1:15321/'));
        if (page) {
            await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
            await page.screenshot({ path: path.join(__dirname, '../output/playwright/board-media-filter-failed.png') });
            console.error(JSON.stringify(await page.evaluate(async () => {
                const data = await window.flowCanvas.store.load();
                const file = data.items.find(item => item.id === 'good')?.filePath;
                const preview = file ? await window.flowCanvas.thumb.preview(file, 160) : null;
                return { items: data.items.map(item => ({ id: item.id, kind: item.kind, filePath: item.filePath })),
                    preview: preview && { success: preview.success, error: preview.error },
                    node: window.Konva.stages[0].findOne('#good')?.toObject() };
            })));
        }
        throw error;
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
