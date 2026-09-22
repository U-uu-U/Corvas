const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const baseline = require('../shared/model-config.default.json');
const artifactDir = path.join(__dirname, '../output/playwright');
const fixtureKey = 'smoke-local-api-key-never-send-to-config';
const clone = value => JSON.parse(JSON.stringify(value));
function entry(kind, model, label, hosts) {
    return { ...clone(baseline.models.find(model => model.kind === kind)), id: `smoke.${kind}.${model}`,
        match: { model: [`^${model}$`] }, catalog: { model, hosts, enabled: true },
        presentation: { label, routeLabel: label, routeGroup: '', routeOrder: 0 } };
}
const videoA = entry('video', 'sd2.5-route1', 'Remote video A', ['art.ravenhash.org', 'cart.ravenhash.org']);
const videoB = entry('video', 'sd2.5-route2', 'Remote video B', ['art.ravenhash.org', 'cart.ravenhash.org']);
const imageA = entry('image', 'gpt-image-2', 'Remote image A', ['ai.ravenhash.org']);
const config = { schemaVersion: 1, revision: 1, catalogMode: 'remote',
    catalogScope: { hosts: ['art.ravenhash.org', 'cart.ravenhash.org'], kinds: ['video'] },
    fields: baseline.fields, capabilities: baseline.capabilities, models: [videoA, videoB, imageA] };

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-api-catalog-smoke-'));
    const requests = [];
    let app;
    let page;
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
        response.end(JSON.stringify(config));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await fs.mkdir(artifactDir, { recursive: true });
        await fs.mkdir(path.join(profile, 'data'));
        const items = [{ id: 'api-catalog-video', kind: 'op', nodeType: 'video', x: 100, y: 100, width: 320, height: 180,
            config: { prompt: 'Local fixture only', duration: 30, ratio: '16:9', resolution: '720p' } }];
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'catalog-smoke', items,
            connections: [], folderGroups: [{ id: 'catalog-smoke', name: 'API catalog smoke', savedItems: items,
                connections: [], folders: [], boardRevision: 0 }], mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile,
            FLOW_API_CATALOG_SMOKE_URL: `http://127.0.0.1:${server.address().port}/config` };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: ['--disable-gpu',
            path.join(__dirname, 'api-catalog-smoke-entry.cjs')], env });
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'The main window must open');
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => { errors.push(`Unexpected dialog: ${dialog.message()}`); void dialog.dismiss(); });
        await page.waitForFunction(() => window.__flowCanvasGetModelConfigSnapshot?.().status.origin === 'remote');
        const saved = () => page.evaluate(async () => (await window.flowCanvas.apiConfig.load()).config);
        const form = page.locator('#agentApiForm');
        const choices = () => page.locator('#agentFetchedModelSelect option').evaluateAll(options => options
            .filter(option => option.value && !option.disabled).map(option => ({ value: option.value, label: option.textContent })));
        const expandedModels = async kind => {
            await page.locator(`#agentModelTabs [data-agent-model-kind="${kind}"]`).evaluate(button => button.click());
            return page.locator('.agent-model-list-item strong').allTextContents();
        };
        const refresh = async () => {
            config.revision++;
            await page.evaluate(() => window.__flowCanvasRefreshModelConfig());
            await page.waitForFunction(revision => window.__flowCanvasGetModelConfigSnapshot?.().status.revision === revision, config.revision);
        };
        const openSettings = async () => {
            await page.locator('#agentSettingsBtn').click();
            await page.locator('#agentApiSettingsTab').click();
        };
        const fill = async (name, endpoint) => {
            await page.locator('#agentAddApiBtn').click();
            await page.locator('#agentFormName').fill(name);
            await page.locator('#agentFormEndpoint').fill(endpoint);
            await page.locator('#agentFormKey').fill(fixtureKey);
        };
        const assertManaged = async kind => {
            assert.equal(await page.locator('#agentFormCapability').inputValue(), kind);
            for (const id of ['agentFetchModelsBtn', 'agentAddModelSlotBtn', 'agentAdditionalModels', 'agentFormModel']) {
                assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} must be hidden for remote catalog`);
            }
            assert.equal(await page.locator('#agentFetchedModelSelect').isVisible(), true);
        };
        const save = async name => {
            await page.locator('#agentFormSaveBtn').click();
            await form.waitFor({ state: 'hidden' });
            for (let attempt = 0; attempt < 50; attempt++) {
                const provider = (await saved()).providers.find(provider => provider.name === name);
                if (provider) return provider;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error(`Saved provider missing: ${name}`);
        };
        const edit = async name => {
            await page.locator('.agent-provider-card').filter({ has: page.getByText(name, { exact: true }) })
                .locator('[title="编辑"]').click();
        };
        const snapshot = async (label, width) => {
            await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()
                .find(window => window.webContents.getURL().includes('index.html')).setSize(width, 1000), width);
            await page.locator('#agentFormSaveBtn').scrollIntoViewIfNeeded();
            const issues = await form.evaluate(root => {
                const controls = [...root.querySelectorAll('input, select, button')].filter(element => {
                    const rect = element.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
                });
                const bounds = root.getBoundingClientRect();
                const issues = controls.filter(element => {
                    const rect = element.getBoundingClientRect();
                    return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || element.scrollWidth > element.clientWidth + 3;
                }).map(element => element.id || element.className);
                for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
                    const a = controls[i].getBoundingClientRect();
                    const b = controls[j].getBoundingClientRect();
                    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2
                        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) issues.push(`${controls[i].id}/${controls[j].id}`);
                }
                return issues;
            });
            assert.deepEqual(issues, [], `Form controls overflow or overlap at width ${width}`);
            await page.screenshot({ path: path.join(artifactDir, `api-catalog-${label}.png`) });
        };

        await openSettings();
        await fill('Art remote', 'https://art.ravenhash.org/v1');
        await assertManaged('video');
        assert.deepEqual((await choices()).map(option => option.value), ['sd2.5-route1', 'sd2.5-route2']);
        await page.locator('#agentFetchedModelSelect').selectOption('sd2.5-route2');
        await snapshot('desktop', 1440);
        await snapshot('compact', 820);
        const art = await save('Art remote');
        assert.equal(art.modelCatalog, 'remote');
        assert.deepEqual(art.models, []);
        assert.equal(art.model, 'sd2.5-route2');
        assert.ok((await saved()).globalConfig.videoProviderId.includes(art.id));

        await fill('Cart remote', 'https://cart.ravenhash.org/v1');
        await assertManaged('video');
        const cart = await save('Cart remote');
        assert.equal(cart.modelCatalog, 'remote');
        assert.deepEqual(cart.models, []);
        assert.equal(cart.model, 'sd2.5-route1');
        await page.locator('#agentSettingsBtn').click();
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#api-catalog-video'));
        await page.evaluate(() => window.Konva.stages[0].findOne('#api-catalog-video').fire('click', { evt: { button: 0 } }));
        await page.locator('[data-model]').click();
        assert.ok((await page.locator('.generation-composer-model-options').innerText()).includes('Remote video B'));
        await page.locator('[data-model]').click();

        await openSettings();
        await fill('Image remote', 'https://ai.ravenhash.org/v1');
        await assertManaged('image');
        const image = await save('Image remote');
        assert.equal(image.modelCatalog, 'remote');
        assert.deepEqual(image.models, []);
        assert.equal(image.model, 'gpt-image-2');
        const imageB = entry('image', 'gpt-image-2-extra', 'Remote image B', ['ai.ravenhash.org']);
        config.models.push(imageB);
        await refresh();
        const imageModels = await expandedModels('image');
        assert.equal(imageModels.length, 2);
        assert.ok(imageModels.some(label => label.includes('Remote image B')), 'Saved image account must dynamically expand added CONFIG model');
        await edit('Image remote');
        assert.deepEqual((await choices()).map(option => option.value), ['gpt-image-2', 'gpt-image-2-extra']);
        assert.equal(await page.locator('#agentFetchedModelSelect').inputValue(), 'gpt-image-2');
        await page.locator('#agentApiFormClose').click();

        await edit('Art remote');
        videoB.presentation.label = videoB.presentation.routeLabel = 'Remote video B renamed';
        const videoC = entry('video', 'sd2.5-extra', 'Remote video C', videoA.catalog.hosts);
        config.models.push(videoC);
        videoA.catalog.enabled = false;
        await refresh();
        assert.deepEqual(await choices(), [{ value: 'sd2.5-route2', label: 'Remote video B renamed' },
            { value: 'sd2.5-extra', label: 'Remote video C' }]);
        assert.equal(await page.locator('#agentFetchedModelSelect').inputValue(), 'sd2.5-route2');
        videoB.catalog.enabled = false;
        await refresh();
        assert.equal(await page.locator('#agentFetchedModelSelect').inputValue(), 'sd2.5-route2', 'Disabling selected model must retain its binding');
        assert.equal(await page.locator('#agentFetchedModelSelect option:checked').isDisabled(), true);
        config.models = [];
        await refresh();
        await assertManaged('video');
        assert.deepEqual(await choices(), []);
        assert.equal(await page.locator('#agentFetchedModelSelect').isDisabled(), true);
        await page.locator('#agentApiFormClose').click();
        await edit('Image remote');
        await assertManaged('image');
        assert.deepEqual(await choices(), [], 'Removed image catalog must not restore local models outside scope');
        assert.deepEqual(await expandedModels('image'), [], 'Cleared image catalog must also clear generation choices');
        await page.locator('#agentApiFormClose').click();

        await fill('Custom text', 'https://custom.example.invalid/v1');
        await page.locator('#agentFormCapability').selectOption('text');
        assert.equal(await page.locator('#agentFetchModelsBtn').isVisible(), true);
        assert.equal(await page.locator('#agentAddModelSlotBtn').isVisible(), true);
        await page.locator('#agentFormModel').fill('custom-text-v1');
        const custom = await save('Custom text');
        assert.notEqual(custom.modelCatalog, 'remote');
        assert.deepEqual(custom.models, ['custom-text-v1']);
        assert.equal(custom.model, 'custom-text-v1');
        assert.ok((await expandedModels('text')).some(label => label.includes('custom-text-v1')));
        assert.equal(await app.evaluate(() => globalThis.apiCatalogSmoke.fetchModelsCalls), 0);
        assert.ok(requests.length >= 5, 'Real localhost CONFIG requests must be observed');
        assert.equal(JSON.stringify(requests).includes(fixtureKey), false, 'CONFIG server must never receive API keys');
        assert.ok(requests.every(request => !request.headers.authorization && !request.headers['x-api-key']));
        assert.deepEqual(errors, []);
        console.log('PASS API catalog desktop smoke: art/cart direct save; remote image outside scope; live rename/add/disable/clear; custom text; no model-list calls or CONFIG key leakage; desktop and compact layout.');
    } catch (error) {
        if (page && !page.isClosed()) {
            console.error('CONFIG status:', await page.evaluate(() => window.__flowCanvasGetModelConfigSnapshot?.().status));
            console.error('Fixture requests:', requests.length);
            console.error('Saved providers:', await page.evaluate(async () => (await window.flowCanvas.apiConfig.load()).config.providers
                .map(({ name, model, modelCatalog }) => ({ name, model, modelCatalog }))));
            await page.screenshot({ path: path.join(artifactDir, 'api-catalog-failure.png') }).catch(() => {});
        }
        throw error;
    } finally {
        await app?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        assert.ok(profile.startsWith(path.join(os.tmpdir(), 'flow-api-catalog-smoke-')));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
