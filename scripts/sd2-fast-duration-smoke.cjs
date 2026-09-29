const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const config = { schemaVersion: 1, revision: 1, catalogMode: 'remote', models: [{
    id: 'sd2-fast', kind: 'video', match: { model: ['^sd2-fast$'] },
    catalog: { model: 'sd2-fast', hosts: ['art.ravenhash.org'], enabled: true },
    presentation: { label: 'sd2-fast', routeLabel: 'sd2-fast', routeGroup: '' },
    capabilities: { referenceImages: { supported: true, max: 9 }, referenceVideos: { supported: false, max: 0 },
        referenceAudios: { supported: true, max: 3 } },
    options: { duration: { type: 'range', min: 1, max: 15, default: 10, integer: true },
        resolutionTier: { type: 'enum', values: ['480p', '720p'], default: '480p' },
        ratio: { type: 'enum', values: ['16:9', '9:16'], default: '9:16' } },
    parameterRules: { version: 1, rules: [
        { when: { resolutionTier: '720p' }, options: { duration: { type: 'range', min: 1, max: 12, integer: true, default: 10 } } },
        { when: { resolutionTier: '480p' }, options: { duration: { type: 'range', min: 1, max: 15, integer: true, default: 10 } } }
    ] }
}] };

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-sd2-duration-'));
    const artifacts = path.join(__dirname, '../output/playwright');
    const server = http.createServer((_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(config));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let app;
    try {
        await fs.mkdir(artifacts, { recursive: true });
        await fs.mkdir(path.join(profile, 'data'));
        const prompt = '0-15秒：保持画面连贯，不添加字幕。';
        const items = [{ id: 'duration-video', kind: 'op', nodeType: 'video', x: 80, y: 90, width: 320, height: 180,
            config: { prompt, duration: 15, resolution: '480p', ratio: '9:16' } }];
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'duration', items,
            connections: [], folderGroups: [{ id: 'duration', name: 'Duration verification', savedItems: items,
                connections: [], folders: [], boardRevision: 0 }], mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile,
            FLOW_API_CATALOG_SMOKE_URL: `http://127.0.0.1:${server.address().port}/config` };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: ['--disable-gpu', path.join(__dirname, 'api-catalog-smoke-entry.cjs')], env });
        let page;
        for (let i = 0; i < 100; i++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => window.__flowCanvasGetModelConfigSnapshot?.().status.origin === 'remote');
        await page.locator('#agentSettingsBtn').click();
        await page.locator('#agentApiSettingsTab').click();
        await page.locator('#agentAddApiBtn').click();
        await page.locator('#agentFormName').fill('Duration fixture');
        await page.locator('#agentFormEndpoint').fill('https://art.ravenhash.org/v1');
        await page.locator('#agentFormKey').fill('fixture-only-no-paid-requests');
        await page.locator('#agentFetchedModelSelect').selectOption('sd2-fast');
        await page.locator('#agentFormSaveBtn').click();
        await page.locator('#agentApiForm').waitFor({ state: 'hidden' });
        await page.locator('#agentSettingsBtn').click();
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#duration-video'));
        await page.evaluate(() => window.Konva.stages[0].findOne('#duration-video').fire('click', { evt: { button: 0 } }));
        await page.locator('[data-model]').click();
        await page.locator('.generation-composer-model-option').filter({ hasText: 'sd2-fast' }).click();
        const referenceLabel = await page.locator('.generation-composer-reference-add').getAttribute('aria-label');
        assert.match(referenceLabel, /图片最多9.*音频最多3/);
        assert.doesNotMatch(referenceLabel, /视频最多/);
        const slider = page.getByRole('slider', { name: '视频时长', exact: true });
        const chooseResolution = async resolution => {
            await page.getByRole('button', { name: '输出分辨率', exact: true }).click();
            await page.getByRole('option', { name: resolution, exact: true }).click();
        };
        await chooseResolution('480p');
        assert.equal(await slider.getAttribute('max'), '14');
        await slider.fill('14');
        assert.equal(await slider.getAttribute('aria-valuetext'), '15s');
        await chooseResolution('720p');
        assert.equal(await slider.getAttribute('max'), '11');
        assert.equal(await slider.getAttribute('aria-valuetext'), '12s');
        assert.match(await page.locator('[data-prompt]').innerText(), /0-15秒/);
        await page.screenshot({ path: path.join(artifacts, 'sd2-duration-720p.png') });
        await chooseResolution('480p');
        assert.equal(await slider.getAttribute('max'), '14');
        assert.equal(await slider.getAttribute('aria-valuetext'), '12s');
        await slider.fill('14');
        assert.equal(await slider.getAttribute('aria-valuetext'), '15s');
        config.models[0].parameterRules.rules[0].options.duration.max = 20;
        config.revision++;
        await page.evaluate(() => window.__flowCanvasRefreshModelConfig());
        await chooseResolution('720p');
        assert.equal(await slider.getAttribute('max'), '19', 'Remote widening must not retain the former local 12s ceiling');
        await slider.fill('19');
        assert.equal(await slider.getAttribute('aria-valuetext'), '20s');
        config.models[0].parameterRules.rules[0].options.duration.max = 12;
        config.revision++;
        await page.evaluate(() => window.__flowCanvasRefreshModelConfig());
        assert.equal(await slider.getAttribute('max'), '11', 'Published rollback updates an open parameter panel');
        assert.equal(await slider.getAttribute('aria-valuetext'), '12s');
        await chooseResolution('480p');
        await slider.fill('14');
        await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows().find(window => /index\.html/.test(window.webContents.getURL()));
            window.setContentSize(820, 760);
        });
        await page.waitForFunction(() => !document.querySelector('#titlebarStatus')?.classList.contains('status-visible'));
        await page.screenshot({ path: path.join(artifacts, 'sd2-duration-480p-compact.png') });
        assert.equal(await slider.evaluate(element => element.getBoundingClientRect().right <= innerWidth), true);
        assert.deepEqual(errors, []);
        assert.equal(await app.evaluate(() => globalThis.apiCatalogSmoke.fetchModelsCalls), 0);
        console.log('PASS SD2 Fast resolution-duration controls: 480p 15s -> 720p 12s -> 480p 15s; prompt preserved; no paid generation.');
    } finally {
        await app?.close();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
