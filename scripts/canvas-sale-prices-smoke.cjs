const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const hosts = ['art.ravenhash.org', 'cart.ravenhash.org'];
const checkedAt = '2026-09-24T05:00:00Z';
const price = (host, amount, unit = 'request') => ({ host, status: 'known', currency: 'CNY', kind: 'sale',
    source: 'relay billing snapshot', updatedAt: checkedAt, prices: [{ label: '', amount, unit }] });
const model = (wire, label, amounts, grouped = true) => ({ id: `smoke.${wire}`, kind: 'video',
    match: { model: [`^${wire.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`] },
    catalog: { model: wire, hosts, enabled: true },
    presentation: { label, routeLabel: label, routeGroup: grouped ? 'price-smoke' : '',
        routeGroupLabel: 'Seedance 推荐渠道', routeGroupAlways: grouped, routeGroupScope: 'catalog' },
    options: { duration: { type: 'fixed', value: 30 }, ratio: { type: 'enum', values: ['16:9', '9:16'], default: '16:9' },
        resolutionTier: { type: 'enum', values: ['480p', '720p'], default: '720p' } },
    capabilities: { referenceImages: { supported: true, max: 10 }, referenceVideos: { supported: false, max: 0 },
        referenceAudios: { supported: false, max: 0 } },
    salePrices: hosts.map((host, index) => price(host, amounts[index])) });
const pro = model('seedance-2.5-pro', 'Seedance 2.5 Pro', [9.8, 11.2]);
const dola = model('oc-model-r5cfh8', 'dola（9图30秒）', [5, 5.72]);
const minimax = model('minimax-h3', 'MiniMax H3', [0.05, 0.06], false);
for (const [index, entry] of minimax.salePrices.entries()) entry.prices = [
    { label: '480p', amount: index ? 0.06 : 0.05, unit: 'second' },
    { label: '720p', amount: index ? 0.24 : 0.2, unit: 'second' }
];
const unknown = model('unknown-sale', 'Unknown Sale', [0, 0], false);
unknown.salePrices = hosts.map(host => ({ ...price(host, 0), status: 'unknown', prices: [] }));
const config = { schemaVersion: 1, revision: 1, catalogMode: 'remote', catalogScope: { hosts, kinds: ['video'] },
    models: [pro, dola, minimax, unknown] };

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-sale-prices-'));
    const artifacts = path.join(__dirname, '../output/playwright');
    const requests = [];
    const server = http.createServer((request, response) => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
        response.end(JSON.stringify(config));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let app;
    let page;
    try {
        await fs.mkdir(artifacts, { recursive: true });
        await fs.mkdir(path.join(profile, 'data'));
        const items = [{ id: 'sale-video', kind: 'op', nodeType: 'video', x: 80, y: 100, width: 320, height: 180,
            config: { prompt: 'A quiet city street at sunrise', duration: 30, ratio: '16:9', resolution: '720p' } }];
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'sale-smoke', items,
            connections: [], folderGroups: [{ id: 'sale-smoke', name: 'Sale prices', savedItems: items,
                connections: [], folders: [], boardRevision: 0 }], mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile,
            FLOW_API_CATALOG_SMOKE_URL: `http://127.0.0.1:${server.address().port}/config` };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: ['--disable-gpu', path.join(__dirname, 'api-catalog-smoke-entry.cjs')], env });
        for (let attempt = 0; attempt < 100; attempt++) {
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
        for (const [index, host] of hosts.entries()) {
            await page.locator('#agentAddApiBtn').click();
            await page.locator('#agentFormName').fill(index ? 'Cart account' : 'Art account');
            await page.locator('#agentFormEndpoint').fill(`https://${host}/v1`);
            await page.locator('#agentFormKey').fill('fixture-key-never-send');
            await page.locator('#agentFetchedModelSelect').selectOption('seedance-2.5-pro');
            await page.locator('#agentFormSaveBtn').click();
            await page.locator('#agentApiForm').waitFor({ state: 'hidden' });
        }
        await page.locator('#agentSettingsBtn').click();
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#sale-video'));
        await page.evaluate(() => window.Konva.stages[0].findOne('#sale-video').fire('click', { evt: { button: 0 } }));
        const selectedPrice = page.locator('[data-sale-price]');
        const choose = async (label, site, grouped = true) => {
            await page.locator('[data-model]').click();
            if (grouped) await page.locator('.generation-composer-route-trigger').filter({ hasText: 'Seedance 推荐渠道' }).hover();
            const account = site === '老站售价' ? 'Art account' : 'Cart account';
            const option = page.locator(`.generation-composer-model-option[title*="${account}"]`).filter({ hasText: label });
            assert.equal(await option.count(), 1, 'Each model must resolve to exactly one account price');
            await option.click();
        };
        await choose('Seedance 2.5 Pro', '老站售价');
        assert.match(await selectedPrice.innerText(), /售价.*9\.80\/次/s);
        await choose('Seedance 2.5 Pro', '新站售价');
        assert.match(await selectedPrice.innerText(), /售价.*11\.20\/次/s);
        await choose('dola（9图30秒）', '老站售价');
        assert.match(await selectedPrice.innerText(), /售价.*5\.00\/次/s);
        await choose('dola（9图30秒）', '新站售价');
        assert.match(await selectedPrice.innerText(), /售价.*5\.72\/次/s);

        // Prices can change without changing the published catalog revision.
        dola.salePrices[1].prices[0].amount = 6.25;
        await page.evaluate(() => window.__flowCanvasRefreshModelConfig());
        await page.waitForFunction(() => document.querySelector('[data-sale-price]')?.textContent.includes('6.25/次'));
        dola.salePrices[1].prices[0].amount = 5.72;
        await page.evaluate(() => window.__flowCanvasRefreshModelConfig());
        await choose('MiniMax H3', '新站售价', false);
        assert.match(await selectedPrice.innerText(), /0\.24\/秒/);
        await page.getByRole('button', { name: '输出分辨率', exact: true }).click();
        await page.getByRole('option', { name: '480p', exact: true }).click();
        assert.match(await selectedPrice.innerText(), /0\.06\/秒/);
        await choose('Unknown Sale', '老站售价', false);
        assert.match(await selectedPrice.innerText(), /售价待配置/);
        assert.doesNotMatch(await selectedPrice.innerText(), /0\.00/);

        await choose('Seedance 2.5 Pro', '新站售价');
        for (const [label, width, height] of [['desktop', 1440, 1000], ['compact', 820, 760]]) {
            await app.evaluate(({ BrowserWindow }, dimensions) => {
                const window = BrowserWindow.getAllWindows().find(window => /index\.html/.test(window.webContents.getURL()));
                window.setMinimumSize(600, 560);
                window.setContentSize(...dimensions);
            }, [width, height]);
            await page.locator('[data-model]').click();
            const trigger = page.locator('.generation-composer-route-trigger').filter({ hasText: 'Seedance 推荐渠道' });
            assert.match(await trigger.locator('small').innerText(), /^当前使用：/);
            await trigger.hover();
            await page.waitForFunction(() => getComputedStyle(document.querySelector('.generation-composer-route-panel')).opacity === '1');
            const visiblePrices = page.locator('.generation-composer-model-price:visible, [data-sale-price]:visible');
            assert.ok(await visiblePrices.count() >= 5);
            assert.doesNotMatch((await visiblePrices.allTextContents()).join(' '), /老站|新站/);
            assert.doesNotMatch((await visiblePrices.evaluateAll(elements => elements.map(element => element.title))).join(' '), /老站|新站/);
            const issues = await visiblePrices.evaluateAll(elements => elements.filter(element => {
                const bounds = element.getBoundingClientRect();
                return element.scrollWidth > element.clientWidth + 2 || bounds.left < -1 || bounds.right > innerWidth + 1;
            }).map(element => element.textContent));
            assert.deepEqual(issues, [], `${label} sale price overflow`);
            await page.screenshot({ path: path.join(artifacts, `canvas-sale-prices-${label}.png`), animations: 'disabled' });
            await page.locator('[data-model]').click();
        }
        assert.deepEqual(errors, []);
        assert.ok(requests.every(request => !request.authorization));
        assert.equal(await app.evaluate(() => globalThis.apiCatalogSmoke.fetchModelsCalls), 0);
        console.log('PASS canvas sales: art/cart exact prices, same-revision refresh, resolution tiers, unknown state, desktop/compact layout; no generation requests.');
    } catch (error) {
        if (page) await page.screenshot({ path: path.join(artifacts, 'canvas-sale-prices-failure.png') }).catch(() => {});
        throw error;
    } finally {
        await app?.close();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
