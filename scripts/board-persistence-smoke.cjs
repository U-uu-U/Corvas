// Isolated renderer regression: deletion, project switches, restart, and image landing.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-board-persistence-'));
    const media = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-board-media-'));
    const filePath = path.join(media, 'deleted.png');
    const boardPath = path.join(profile, 'data', 'board.json');
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#368b76' } }).png().toBuffer();
    let submissions = 0;
    const server = http.createServer((request, response) => {
        request.resume();
        if (request.method === 'POST' && request.url === '/v1/images/generations') {
            submissions++;
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
        } else { response.statusCode = 404; response.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let app;
    const errors = [];
    const read = async () => JSON.parse(await fs.readFile(boardPath, 'utf8'));
    const launch = async () => {
        const env = { ...process.env, FLOW_MEDIA_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: [path.join(__dirname, 'media-preview-smoke-entry.cjs')], env });
        app.process().stderr.on('data', bytes => {
            const text = bytes.toString();
            if (/FlowCanvasBridge|ReferenceError|Error:/.test(text)) console.log(text);
        });
        let page;
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(candidate => /\/dist\/index\.html/.test(candidate.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'Main renderer did not open');
        page.on('pageerror', error => errors.push(error.stack));
        await page.waitForFunction(() => window.Konva?.stages?.length && window.flowCanvas?.store);
        await page.waitForSelector('.folder-group-item');
        return page;
    };
    try {
        await fs.mkdir(path.dirname(boardPath), { recursive: true });
        await fs.writeFile(filePath, png);
        const items = [
            { id: 'deleted', kind: 'media', mediaType: 'image', filePath, x: 40, y: 40, width: 100, height: 100 },
            { id: 'generated', kind: 'op', nodeType: 'image', model: 'gpt-image-2',
                config: { prompt: 'local test fixture', model: 'gpt-image-2', providerId: 'fixture', count: 1 },
                x: 240, y: 40, width: 200, height: 200 }
        ];
        const removed = Array.from({ length: 1268 }, (_, index) => path.join(media, `old-${index}.png`));
        await fs.writeFile(boardPath, JSON.stringify({ activeGroupId: 'a', items, connections: [],
            viewport: { x: 0, y: 0, scale: 1 }, watchFolders: [media], defaultSaveFolder: media,
            removedFromBoardPaths: removed, removedFromBoardPathsInitialized: true,
            folderGroups: [
                { id: 'a', name: 'A', folders: [media], defaultSaveFolder: media, savedItems: items,
                    connections: [], boardRevision: 0, removedFromBoardPaths: removed, removedFromBoardPathsInitialized: true },
                { id: 'b', name: 'B', folders: [], savedItems: [], connections: [], boardRevision: 0,
                    removedFromBoardPaths: [], removedFromBoardPathsInitialized: true }
            ], mcp: { enabled: false } }));
        let page = await launch();
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#deleted'));
        await page.evaluate(() => {
            document.activeElement?.blur();
            window.Konva.stages[0].findOne('#deleted').fire('click', { evt: { button: 0, ctrlKey: true } });
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        });
        await page.waitForFunction(() => !window.Konva.stages[0].findOne('#deleted'));
        const immediatelySaved = await read();
        assert.ok(!immediatelySaved.items.some(item => item.id === 'deleted'), 'Delete must persist before debounce/quit');
        assert.deepEqual(immediatelySaved.removedFromBoardPaths,
            immediatelySaved.folderGroups.find(group => group.id === 'a').removedFromBoardPaths);
        // Switch before the one-second save debounce expires.
        await page.locator('[data-group-id="b"] .group-header').click();
        await page.locator('[data-group-id="a"] .group-header').click();
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#generated'));
        assert.equal(await page.evaluate(() => Boolean(window.Konva.stages[0].findOne('#deleted'))), false);
        await app.close(); app = null;
        let stored = await read();
        assert.ok(!stored.items.some(item => item.id === 'deleted'));
        assert.ok(stored.removedFromBoardPaths.some(p => p.endsWith('/deleted.png') || p.endsWith('\\deleted.png')));
        page = await launch();
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#generated'));
        assert.equal(await page.evaluate(() => Boolean(window.Konva.stages[0].findOne('#deleted'))), false);
        await page.evaluate(async endpoint => {
            const providers = [{ id: 'fixture', name: 'Local fixture', type: 'openai', capability: 'image',
                model: 'gpt-image-2', models: ['gpt-image-2'], endpoint, apiKey: 'fixture' }];
            const globalConfig = { imageIntentPipelineMode: 'off', imageIntentPipelineVersion: 2 };
            await window.flowCanvas.apiConfig.save({ version: 1, revision: 100, providers, globalConfig });
            localStorage.setItem('flow-canvas-agent-global-config', JSON.stringify(globalConfig));
            localStorage.setItem('flow-canvas-agent-providers', JSON.stringify(providers));
            localStorage.setItem('flow-canvas-api-config-meta-v1', JSON.stringify({ version: 1, revision: 100 }));
        }, `http://127.0.0.1:${server.address().port}/v1`);
        await page.reload();
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#generated'));
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('context-run-node', { detail: { nodeId: 'generated' } })));
        for (let attempt = 0; attempt < 300; attempt++) {
            stored = await read();
            const item = stored.items.find(i => i.id === 'generated');
            if (item?.runError) {
                console.log(JSON.stringify(await page.evaluate(() => window.flowCanvas.diagnostics.summary())));
                throw new Error(item.runError);
            }
            if (item?.kind === 'media' && item.filePath) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const output = stored.items.find(item => item.id === 'generated');
        assert.ok(output?.filePath, JSON.stringify({ node: output, errors, submissions }));
        await fs.access(output.filePath);
        assert.equal(submissions, 1);
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/board-persistence.png') });
        await app.close(); app = null;
        page = await launch();
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#generated')?.findOne('.displayNode'));
        assert.equal(await page.evaluate(() => Boolean(window.Konva.stages[0].findOne('#deleted'))), false);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ deletionRestart: true, imageLandingRestart: true, submissions }));
    } finally {
        if (app) await app.close();
        await new Promise(resolve => server.close(resolve));
        assert.ok(profile.startsWith(path.join(os.tmpdir(), 'corvas-board-persistence-')));
        await fs.rm(profile, { recursive: true, force: true });
        assert.ok(media.startsWith(path.join(os.tmpdir(), 'corvas-board-media-')));
        await fs.rm(media, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
