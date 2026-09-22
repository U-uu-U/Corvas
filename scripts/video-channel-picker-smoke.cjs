const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-channel-picker-'));
    let app;
    try {
        const { getVideoModelProfile, getVideoModelGroup, describeVideoModelProfile } = await import(pathToFileURL(path.join(__dirname, '../shared/video-model-profiles.mjs')));
        const { isVideoGenerationAvailable } = await import(pathToFileURL(path.join(__dirname, '../shared/video-generation-availability.mjs')));
        const models = ['artsdance2-0-fast-intl-260701', 'artsdance2-0-mini-intl-260701', 'artsdance2-0-pro-intl-260701',
            'minimax-h3', 'seedance_v2.5', 'sd2.5', 'sd2.5-route1', 'seedance_v2.0-933',
            'seedance_v2.5-101010', 'seedance_v2.5-301010', 'seedance-2.5-pro'];
        const raw = models.map(model => ({ id: model, sourceProviderId: 'relay', endpoint: 'https://art.ravenhash.org/v1', name: 'RavenHash', model }));
        raw.push({ id: 'global', model: 'sd_2.5_discount_v1', endpoint: 'https://zcbservice.aizfw.cn/kyyReactApiServer/v2/model-center/tasks' },
            { id: 'star', sourceProviderId: 'star', name: 'StarFrame API', model: 'ch0107-sd-2.5-720p', endpoint: 'https://api.xzapi.vip/v1' },
            { id: 'star', sourceProviderId: 'star', name: 'StarFrame API', model: 'ch1401-sd-2.5-720p', endpoint: 'https://api.xzapi.vip/v1' });
        const sidebar = await fs.readFile(path.join(__dirname, '../src/agent-sidebar.js'), 'utf8');
        const optionsMethod = sidebar.slice(sidebar.indexOf('    getGenerationProviderOptions('), sidebar.indexOf('    getImageProviderConfig('));
        const OptionsFixture = new Function('isVideoGenerationAvailable', 'describeVideoModelProfile', 'describeModelPresentation',
            `return class { ${optionsMethod} }`)(isVideoGenerationAvailable, describeVideoModelProfile, () => '');
        const optionsFixture = new OptionsFixture();
        optionsFixture._providerVariants = () => raw;
        optionsFixture._isVideoProvider = () => true;
        optionsFixture._getProviderPresentation = provider => ({ ...getVideoModelProfile(provider), ...getVideoModelGroup(provider) });
        const providers = optionsFixture.getGenerationProviderOptions('video');
        assert.equal(providers.length, 11);
        assert.ok(providers.every(provider => !/¥|US\$|价格|费用/.test(provider.description)));
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
                element.style.cssText = 'position:fixed;left:10px;top:24px;width:320px;max-width:calc(100vw - 20px);z-index:999999';
                document.body.append(element); active.element = element; active.popover = { element };
            };
            fixture._closeGenerationComposerPopover = active => {
                active.popover?.cleanup?.(); active.element?.remove(); active.popover = null;
            };
            fixture._applyImageGenerationProviderSelection = (node, provider) => { node.config = { ...provider }; };
            for (const name of ['_syncGenerationComposerModelButton', '_renderGenerationComposerParameters', '_syncGenerationComposerCount', 'refreshOpNode', 'emit']) fixture[name] = () => {};
            window.channelFixture = { fixture, data, providers };
            fixture._showGenerationComposerModelMenu('node', {});
        }, { methods, providers });
        const groups = page.locator('.generation-composer-model-routes');
        const recommended = groups.filter({ has: page.locator('.generation-composer-route-trigger strong', { hasText: 'Seedance 2.5 推荐渠道' }) });
        const backup = groups.filter({ has: page.locator('.generation-composer-route-trigger strong', { hasText: 'Seedance 2.5 备用渠道' }) });
        const version2 = groups.filter({ has: page.locator('.generation-composer-route-trigger strong', { hasText: 'Seedance 2.0 推荐渠道' }) });
        const topTitles = page.locator('.generation-composer-model-options > .generation-composer-model-option strong, .generation-composer-route-trigger strong');
        assert.deepEqual(await topTitles.allTextContents(), ['MiniMax H3', 'Seedance 2.5 推荐渠道', 'Seedance 2.5 备用渠道', 'Seedance 2.0 推荐渠道']);
        assert.deepEqual(await recommended.locator('.generation-composer-model-option strong').allTextContents(),
            ['SD2.5 固定 30 秒（电商效果优化）', 'Seedance 2.5 Pro（满血满参）', 'HM-Seedance 2.5', 'HM-Seedance 2.0 933']);
        assert.deepEqual(await backup.locator('.generation-composer-model-option strong').allTextContents(),
            ['Seedance 2.5 固定 30 秒（过人脸）', '2.5pro 备用（满参）', '2.5pro 备用（卡人脸）']);
        assert.deepEqual(await version2.locator('.generation-composer-model-option strong').allTextContents(), ['Seedance 2.0 Fast', 'Seedance 2.0 Mini', 'Seedance 2.0 Pro']);
        assert.deepEqual(await groups.locator('.generation-composer-route-trigger small').allTextContents(), [
            '当前使用：SD2.5 固定 30 秒（电商效果优化）',
            '当前使用：Seedance 2.5 固定 30 秒（过人脸）',
            '当前使用：Seedance 2.0 Fast'
        ]);
        assert.equal(await page.locator('.generation-composer-model-option').count(), 11);
        assert.doesNotMatch(await page.locator('.generation-composer-model-options').textContent(), /¥|US\$|价格|费用/);
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        const openGroup = async group => {
            await group.locator('.generation-composer-route-trigger').hover();
            await group.locator('.generation-composer-route-panel').evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));
        };
        for (const [label, width] of [['desktop', 1000], ['compact', 360]]) {
            await app.evaluate(({ BrowserWindow }, width) => {
                const win = BrowserWindow.getAllWindows()[0];
                win.setMinimumSize(320, 480); win.setSize(width, 720);
            }, width);
            await page.waitForFunction(width => window.innerWidth === width, width);
            for (const [name, group] of [['recommended', recommended], ['backup', backup], ['version2', version2]]) {
                await openGroup(group);
                const bounds = await group.locator('.generation-composer-route-panel').boundingBox();
                assert.ok(bounds, `${label} ${name} panel must remain visible`);
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
                if (width < 600) {
                    const trigger = await group.locator('.generation-composer-route-trigger').boundingBox();
                    assert.ok(bounds.y >= trigger.y + trigger.height || bounds.y + bounds.height <= trigger.y,
                        'Compact flyout must not cover its own trigger');
                }
                assert.equal(await group.locator('strong, small').evaluateAll(elements => elements.every(element =>
                    element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)), true);
                await page.screenshot({ path: path.join(output, `video-channels-${label}-${name}.png`), animations: 'disabled' });
                await group.locator('.generation-composer-route-trigger').focus();
                await page.keyboard.press('Escape');
            }
        }
        for (const [group, model] of [[recommended, 'sd2.5'], [recommended, 'seedance-2.5-pro'], [backup, 'sd2.5-route1'],
            [backup, 'ch0107-sd-2.5-720p'], [backup, 'ch1401-sd-2.5-720p'], [version2, 'artsdance2-0-mini-intl-260701']]) {
            await group.locator('.generation-composer-route-trigger').focus();
            await page.keyboard.press('ArrowRight');
            const index = await group.locator('.generation-composer-model-option small').allTextContents();
            const position = index.findIndex(text => text.startsWith(model + ' ·') || text === model);
            assert.ok(position >= 0, `Wire ID ${model} must be visible`);
            await group.locator('.generation-composer-model-option').nth(position).click();
            const selected = await page.evaluate(() => window.channelFixture.data.config);
            assert.equal(selected.model, model);
            const expectedSource = /^ch(?:0107|1401)-sd-2\.5-720p$/.test(model) ? 'star' : 'relay';
            assert.equal(selected.sourceProviderId, expectedSource);
            if (expectedSource === 'star') assert.equal(selected.id, 'star');
            await page.evaluate(() => window.channelFixture.fixture._showGenerationComposerModelMenu('node', {}));
            assert.equal(await group.locator('.generation-composer-route-trigger small').innerText(), `当前使用：${selected.routeLabel}`);
        }
        const search = page.locator('.generation-composer-popover-search input');
        await search.fill('备用渠道');
        assert.equal(await groups.count(), 1);
        assert.equal(await page.locator('.generation-composer-model-option').count(), 3);
        await search.fill('可NSFW');
        assert.equal(await groups.count(), 1);
        assert.equal(await page.locator('.generation-composer-model-option').count(), 3);
        await search.fill('301010');
        assert.equal(await page.locator('.generation-composer-model-option').count(), 0);
        await page.evaluate(() => window.channelFixture.fixture._closeGenerationComposerPopover(window.channelFixture.fixture._generationComposer));
        const runtimeBundle = await require('esbuild').build({
            entryPoints: [path.join(__dirname, '../src/agent-runtime-view.js')], bundle: true,
            format: 'iife', globalName: 'RuntimePriceSmoke', write: false
        });
        await page.addScriptTag({ content: runtimeBundle.outputFiles[0].text });
        const runtimeStates = await page.evaluate(() => {
            const card = window.RuntimePriceSmoke.createRuntimeCard({ onAction: async () => {} });
            card.root.style.cssText = 'position:fixed;left:10px;top:24px;width:320px;background:#202124;padding:16px;z-index:999999';
            document.body.append(card.root);
            const price = { kind: 'sale', amount: 1.25, currency: 'CNY', unit: 'second', source: 'smoke' };
            return [price, null].map(price => {
                const plan = { kind: 'generation', version: 1, summary: '生成视频', priceKnown: Boolean(price),
                    estimatedCost: price ? 5 : 0, currency: 'CNY',
                    steps: [{ title: '生成视频', kind: 'video', model: 'seedance-2.5-pro', count: 1, price }] };
                const before = JSON.stringify(plan);
                card.update({ id: 'price-smoke', status: 'awaiting_confirmation', plan, events: [] });
                return { text: card.root.textContent, detail: card.root.querySelector('.agent-runtime-steps small').textContent,
                    unchanged: before === JSON.stringify(plan) };
            });
        });
        for (const state of runtimeStates) {
            assert.doesNotMatch(state.text, /¥|US\$|CNY|价格|费用/);
            assert.equal(state.detail, 'seedance-2.5-pro · 数量 1');
            assert.equal(state.unchanged, true, 'Rendering must preserve structured billing data');
        }
        await page.screenshot({ path: path.join(output, 'video-channels-runtime-no-prices.png'), animations: 'disabled' });
        console.log('Video channel picker passed: grouping, hidden model and plan prices, labels, order, pause filtering, single-model group, search, keyboard selection and compact layout.');
    } finally {
        await app?.close();
        const relative = path.relative(os.tmpdir(), profile);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
