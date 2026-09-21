const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-zhubo-picker-'));
    let app;
    try {
        const { getVideoModelProfile, getVideoModelGroup, describeVideoModelProfile } = await import(pathToFileURL(path.join(__dirname, '../shared/video-model-profiles.mjs')));
        const { isVideoGenerationAvailable } = await import(pathToFileURL(path.join(__dirname, '../shared/video-generation-availability.mjs')));
        const models = ['seedance_v2.5', 'sd2.5', 'seedance_v2.0-933', 'seedance_v2.5-101010', 'seedance_v2.5-301010', 'seedance-2.5-pro', 'sd2.5-route1'];
        const providers = models.map(model => {
            const provider = { id: model, sourceProviderId: 'relay', endpoint: 'https://art.ravenhash.org/v1', name: 'RavenHash', model };
            const presentation = { ...getVideoModelProfile(provider), ...getVideoModelGroup(provider) };
            return { ...provider, ...presentation, modelLabel: presentation.label,
                description: describeVideoModelProfile(presentation, { includePrice: false }) };
        }).filter(isVideoGenerationAvailable);
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        let page;
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        await page.waitForFunction(() => window.flowCanvas?.store);
        const source = await fs.readFile(path.join(__dirname, '../src/canvas.js'), 'utf8');
        const methods = source.slice(source.indexOf('    _showGenerationComposerModelMenu('), source.indexOf('    _showGenerationComposerPromptPresets('));
        await page.evaluate(({ methods, providers }) => {
            const Fixture = new Function(`return class { ${methods} }`)();
            const fixture = new Fixture(), data = { nodeType: 'video', config: {} };
            fixture.items = new Map([['node', { data }]]);
            fixture._generationComposer = { nodeId: 'node' };
            fixture.options = { getGenerationProviders: () => providers };
            fixture._mountGenerationComposerPopover = (active, element) => {
                element.style.cssText = 'position:fixed;left:80px;top:70px;width:320px;z-index:999999';
                document.body.append(element); active.element = element; active.popover = { element };
            };
            fixture._closeGenerationComposerPopover = active => {
                active.popover?.cleanup?.(); active.element?.remove(); active.popover = null;
            };
            fixture._applyImageGenerationProviderSelection = (node, provider) => { node.config = { ...provider }; };
            for (const name of ['_syncGenerationComposerModelButton', '_renderGenerationComposerParameters', '_syncGenerationComposerCount', 'refreshOpNode', 'emit']) fixture[name] = () => {};
            window.zhuboFixture = { fixture, data };
            fixture._showGenerationComposerModelMenu('node', {});
        }, { methods, providers });
        const group = page.locator('.generation-composer-model-routes').filter({ has: page.locator('.generation-composer-route-trigger strong', { hasText: 'Seedance 2.5 推荐渠道' }) });
        assert.equal(await group.count(), 1);
        assert.equal(await group.locator('.generation-composer-route-trigger strong').innerText(), 'Seedance 2.5 推荐渠道');
        assert.equal(await group.locator('.generation-composer-model-option').count(), 4);
        await group.locator('.generation-composer-route-trigger').hover();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.generation-composer-route-panel')).opacity === '1');
        const pro = group.locator('.generation-composer-model-option').filter({ hasText: 'Seedance 2.5 Pro' });
        assert.equal(await pro.count(), 1);
        assert.doesNotMatch(await pro.innerText(), /¥|US\$|价格|费用/);
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'zhubo-pro-group.png') });
        await pro.click();
        const selected = await page.evaluate(() => window.zhuboFixture.data.config);
        assert.equal(selected.model, 'seedance-2.5-pro');
        assert.equal(selected.sourceProviderId, 'relay');
        assert.deepEqual(selected.resolutions, ['480p', '720p']);
        assert.deepEqual(selected.referenceLimits, { image: 30, video: 10, audio: 10 });
        console.log('Zhubo model picker passed: four available recommended models, Pro selection, hidden prices, resolution and reference limits.');
    } finally {
        await app?.close();
        const relative = path.relative(os.tmpdir(), profile);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
