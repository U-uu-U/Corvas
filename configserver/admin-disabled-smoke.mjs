import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConfigServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-disabled-'));
const groupId = 'video:recommended';
const entry = (id, label, presentation = {}, enabled = true) => ({
    id, kind: 'video',
    catalog: { model: id, hosts: ['art.example.com', 'cart.example.com'], enabled },
    match: { model: [`^${id}$`], provider: ['ravenhash'] },
    presentation: { label, visible: true, ...presentation },
    options: { duration: { type: 'range', min: 4, max: 30, integer: true, default: 4 } },
    pricing: { status: 'known', hosts: ['art.example.com', 'cart.example.com'], amount: 1.25,
        currency: 'CNY', unit: 'second', kind: 'sale', source: 'smoke-fixture', updatedAt: '2026-09-22T00:00:00.000Z' },
    future: { retained: [id, 12] }
});
const group = { routeGroup: 'recommended', routeGroupLabel: 'Seedance 推荐渠道', routeGroupOrder: 10 };
const seed = {
    schemaVersion: 1, revision: 0, catalogMode: 'remote', source: 'disabled-smoke-fixture',
    models: [
        entry('group-main', 'Seedance Main', { ...group, routeOrder: 0 }),
        entry('group-backup', 'Seedance Backup', { ...group, routeOrder: 1 }),
        entry('standalone', 'MiniMax H3', { routeGroupOrder: 0 }),
        entry('hidden', 'Explicitly Hidden', { visible: false, routeGroupOrder: 20 }, false)
    ]
};
let server;
let browser;
try {
    const seedPath = path.join(dataDir, 'catalog-seed.json');
    await fs.writeFile(seedPath, JSON.stringify(seed));
    server = await createConfigServer({ dataDir, seedPath, port: 0, adminPassword: 'disabled-smoke-local',
        logger: { log() {}, warn() {}, error() {} } });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const snapshot = async () => JSON.parse(await page.locator('#configText').inputValue());
    const groupCard = page.locator(`#catalogGroups [data-catalog-group="${groupId}"]`);
    const modelCard = id => page.locator(`#catalogModels [data-catalog-model-id="${id}"]`);
    const independentCard = id => page.locator(`#catalogGroups [data-catalog-model-id="${id}"]`);
    const expectedModels = structuredClone(seed.models);
    const assertRetained = async () => assert.deepEqual((await snapshot()).models, expectedModels);
    const assertSelected = async id => {
        assert.equal(await page.locator('#selectedModelId').textContent(), id);
        assert.equal(await modelCard(id).getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator('[data-field="catalogModel"]').inputValue(), id);
        assert.equal(await page.locator('#modelFields').isEnabled(), true);
    };
    const setEnabled = async (id, enabled, standalone = false) => {
        await (standalone ? independentCard(id) : modelCard(id)).click();
        await page.locator('[data-field="catalogEnabled"]').selectOption(String(enabled));
        expectedModels.find(model => model.id === id).catalog.enabled = enabled;
        await assertSelected(id);
        await assertRetained();
    };
    const assertDarkRed = async locator => {
        const color = await locator.evaluate(element => globalThis.getComputedStyle(element).backgroundColor);
        const [red, green, blue] = color.match(/[\d.]+/g).map(Number);
        assert.ok(red > green * 1.2 && red > blue * 1.1 && red < 140,
            `Disabled card should have a dark red background: ${color}`);
        assert.equal(await locator.isEnabled(), true, 'Disabled catalog cards must remain editable');
    };
    const assertLayout = async () => {
        const size = await page.evaluate(() => ({ width: globalThis.innerWidth,
            scroll: globalThis.document.documentElement.scrollWidth }));
        assert.ok(size.scroll <= size.width, `Horizontal overflow: ${JSON.stringify(size)}`);
    };
    const publish = async () => {
        const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/admin/save'
            && response.request().method() === 'POST');
        await page.locator('#saveBtn').click();
        assert.equal((await saved).status(), 303, 'Publishing the fixture must succeed');
        await page.waitForURL(url => url.pathname === '/admin' && url.searchParams.has('flash'));
        await page.locator('#catalogPane').waitFor({ state: 'visible' });
        assert.deepEqual((await fetch(`${server.url}/config`).then(response => response.json())).models, expectedModels);
    };

    await page.goto(`${server.url}/admin`);
    await page.getByPlaceholder('管理密码').fill('disabled-smoke-local');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('#catalogPane').waitFor({ state: 'visible' });
    await groupCard.click();
    await assertSelected('group-main');
    await assertRetained();
    assert.equal(await page.locator('#catalogModels .catalog-tile').count(), 2);
    assert.equal(await independentCard('hidden').count(), 0);

    await setEnabled('group-main', false);
    assert.equal(await groupCard.count(), 1);
    assert.ok((await groupCard.textContent()).includes('部分停用（1/2）'));
    assert.equal(await modelCard('group-main').getAttribute('data-disabled'), 'true');
    assert.ok((await modelCard('group-main').textContent()).includes('已停用'));
    await assertDarkRed(modelCard('group-main'));

    await setEnabled('group-backup', false);
    assert.equal(await groupCard.getAttribute('data-disabled'), 'true');
    assert.ok((await groupCard.locator('small').textContent()).includes('分组停用'));
    assert.equal(await page.locator('#catalogModels .catalog-tile').count(), 2);
    await assertDarkRed(groupCard);
    await assertDarkRed(modelCard('group-backup'));
    await setEnabled('standalone', false, true);
    assert.equal(await independentCard('standalone').getAttribute('data-disabled'), 'true');
    assert.ok((await independentCard('standalone').textContent()).includes('已停用'));
    await assertDarkRed(independentCard('standalone'));

    await page.locator('#catalogShowHidden').check();
    assert.equal(await independentCard('hidden').count(), 1);
    assert.equal(await independentCard('hidden').getAttribute('data-disabled'), 'true');
    await independentCard('hidden').click();
    await assertSelected('hidden');
    await page.locator('#catalogShowHidden').uncheck();
    assert.equal(await independentCard('hidden').count(), 0);
    assert.equal(await independentCard('standalone').count(), 1);
    assert.equal(await groupCard.count(), 1);
    await assertRetained();

    await publish();
    await page.reload();
    await page.locator('#catalogPane').waitFor({ state: 'visible' });
    await groupCard.click();
    await assertRetained();
    assert.equal(await groupCard.getAttribute('data-disabled'), 'true');
    assert.ok((await groupCard.locator('small').textContent()).includes('分组停用'));
    assert.equal(await page.locator('#catalogModels [data-disabled="true"]').count(), 2);
    assert.equal(await independentCard('standalone').getAttribute('data-disabled'), 'true');
    assert.equal(await independentCard('hidden').count(), 0);
    await modelCard('group-backup').click();
    await assertSelected('group-backup');

    const screenshots = path.resolve('output/playwright');
    await fs.mkdir(screenshots, { recursive: true });
    await assertLayout();
    await page.screenshot({ path: path.join(screenshots, 'config-disabled-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await assertLayout();
    await assertDarkRed(groupCard);
    await page.screenshot({ path: path.join(screenshots, 'config-disabled-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });

    await setEnabled('group-main', true);
    assert.notEqual(await groupCard.getAttribute('data-disabled'), 'true');
    assert.ok((await groupCard.textContent()).includes('部分停用（1/2）'));
    await setEnabled('group-backup', true);
    assert.notEqual(await modelCard('group-backup').getAttribute('data-disabled'), 'true');
    assert.ok(!(await groupCard.textContent()).includes('停用'));
    await setEnabled('standalone', true, true);
    assert.notEqual(await independentCard('standalone').getAttribute('data-disabled'), 'true');
    assert.deepEqual(expectedModels, seed.models);
    await publish();
    await assertRetained();
    assert.deepEqual(errors, []);
    console.log('PASS disabled catalog: partial/full group and standalone retention, editable dark red cards, hidden filtering, publish/reload, restore, desktop/mobile layout, model field preservation.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
