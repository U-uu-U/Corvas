const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const { nanoBananaEntry } = await import('../server/nano-banana/catalog.mjs');
    const root = path.resolve(__dirname, '..');
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-nano-ui-'));
    const assets = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-nano-media-'));
    const sourceImage = await sharp({ create: { width: 96, height: 384, channels: 3, background: '#4395a2' } }).png().toBuffer();
    const requests = [];
    const entry = structuredClone(nanoBananaEntry);
    entry.catalog.hosts = ['127.0.0.1'];
    entry.match.endpoint = '^http://127\\.0\\.0\\.1:';
    const config = { schemaVersion: 1, revision: 700, catalogMode: 'remote', models: [entry] };
    const server = http.createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/config') { response.end(JSON.stringify(config)); return; }
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        requests.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
        response.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [
            { inlineData: { mimeType: 'image/png', data: sourceImage.toString('base64') } }
        ] } }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let app;
    try {
        const source = path.join(assets, 'reference.png'); await fs.writeFile(source, sourceImage);
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(path.join(profile, 'data/relay-browser.json'), JSON.stringify({ onboardingSkipped: true }));
        const items = [{ id: 'nano-ref', kind: 'media', mediaType: 'image', filePath: source, x: 80, y: 80, width: 100, height: 260 },
            { id: 'nano-node', kind: 'op', nodeType: 'image', x: 250, y: 80, width: 200, height: 180,
                config: { prompt: 'A clean product image', model: entry.catalog.model, providerId: 'nano-fixture', resolutionTier: '1K', ratio: 'adaptive', count: 1, webSearch: true } }];
        const connections = [{ id: 'reference-link', from: { nodeId: 'nano-ref', port: 'out' }, to: { nodeId: 'nano-node', port: 'source' } }];
        const boardFile = path.join(profile, 'data/board.json');
        await fs.writeFile(boardFile, JSON.stringify({ items, connections, watchFolders: [assets], activeGroupId: 'nano',
            folderGroups: [{ id: 'nano', name: 'Nano Banana', folders: [assets], savedItems: items, connections,
                viewport: { x: 0, y: 0, scale: 1 }, removedFromBoardPaths: [], removedFromBoardPathsInitialized: true }],
            viewport: { x: 0, y: 0, scale: 1 }, mcp: { enabled: false } }));
        const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
        await fs.writeFile(path.join(profile, 'fixture-api.json'), JSON.stringify({ version: 1, revision: 1, providers: [
            { id: 'nano-fixture', name: 'Nano Banana', capability: 'image', endpoint, type: 'openai', apiKey: 'fixture', model: entry.catalog.model, modelCatalog: 'remote' }
        ], globalConfig: { imageProviderId: 'nano-fixture', imageIntentPipelineMode: 'off', imageIntentPipelineVersion: 2 } }));
        const env = { ...process.env, FLOW_CANVAS_SMOKE_PROFILE: profile, FLOW_CANVAS_SMOKE_ASAR: root,
            FLOW_CANVAS_CONFIG_URL: `http://127.0.0.1:${server.address().port}/config` };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'agent-smoke-entry.cjs')], env });
        let page;
        for (let i = 0; i < 120; i++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => window.flowCanvas?.modelConfig);
        await page.evaluate(url => localStorage.setItem('flow-canvas-model-config-url-v1', url), env.FLOW_CANVAS_CONFIG_URL);
        await page.reload();
        await page.waitForFunction(() => document.visibilityState === 'visible'
            && window.__flowCanvasGetModelConfigSnapshot?.().status.revision === 700 && window.Konva?.stages[0]?.findOne('#nano-node'));
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('context-edit-node', { detail: { nodeId: 'nano-node' } })));
        const composer = page.locator('.generation-composer');
        await composer.waitFor();
        assert.match(await composer.locator('[data-model-label]').innerText(), /Nano Banana 2.1/);
        await composer.locator('[data-image-settings]').click();
        const settings = page.getByRole('dialog', { name: '图片生成参数', exact: true });
        assert.equal(await settings.locator('[data-web-search]').count(), 0);
        assert.deepEqual(await settings.locator('[data-quality] button').allTextContents(), ['1K', '2K', '4K']);
        assert.equal(await settings.locator('[data-ratios] button').count(), 15);
        await settings.locator('[data-quality] button').getByText('2K', { exact: true }).click();
        await settings.locator('[data-ratios] button[data-value="1:4"]').click();
        await fs.mkdir(path.join(root, 'output/playwright'), { recursive: true });
        for (const [theme, width, height] of [['dark', 1440, 960], ['light', 820, 680]]) {
            await page.setViewportSize({ width, height });
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            await page.waitForTimeout(150);
            assert.ok(await settings.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth; }));
            await page.screenshot({ path: path.join(root, `output/playwright/nano-banana-${theme}.png`) });
        }
        await composer.locator('[data-image-settings]').click();
        await composer.getByRole('button', { name: '开始生成', exact: true }).click();
        let landed;
        for (let i = 0; i < 150; i++) {
            const board = JSON.parse(await fs.readFile(boardFile));
            landed = board.items.find(item => item.id === 'nano-node' && item.filePath && item.filePath !== source);
            if (landed) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!landed) {
            const board = JSON.parse(await fs.readFile(boardFile));
            console.log(JSON.stringify({ requests: requests.map(({ method, url }) => ({ method, url })),
                items: board.items, errors, ui: await page.locator('body').innerText() }, null, 2));
            await page.screenshot({ path: path.join(root, 'output/playwright/nano-banana-failure.png') });
            const files = await fs.readdir(profile, { recursive: true });
            for (const file of files.filter(file => /\.(?:log|jsonl)$/.test(file) && /diagnostic/.test(file))) {
                console.log(file, (await fs.readFile(path.join(profile, file), 'utf8')).split('\n').filter(line => /generation\.|image\./.test(line)).join('\n'));
            }
        }
        assert.ok(landed, 'The returned image must land on the original generator node');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, '/v1beta/models/gemini-nano-banana-2.1:generateContent');
        assert.deepEqual(requests[0].body.generationConfig.imageConfig, { imageSize: '2K', aspectRatio: '1:4' });
        assert.equal(requests[0].body.contents[0].parts[1].inlineData.data, sourceImage.toString('base64'));
        assert.ok(landed.filePath.startsWith(assets));
        assert.deepEqual(await fs.readFile(landed.filePath), sourceImage);
        assert.deepEqual(errors, []);
        console.log('PASS Nano Banana UI: named model, native size/ratio controls, image reference, single native POST, image saved and landed; dark/light compact layouts.');
    } finally {
        await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        await fs.rm(assets, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
