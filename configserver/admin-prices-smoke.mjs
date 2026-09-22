import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConfigServer } from './server.mjs';
import { prepareRemoteCatalog } from '../scripts/prepare-remote-catalog.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const useSnapshot = process.env.CONFIG_PRICES_LIVE_SNAPSHOT === '1';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-prices-'));
let server;
let browser;
try {
    const seedPath = path.join(dataDir, 'seed.json');
    const seed = useSnapshot ? await fetch('https://artconfig.ravenhash.org/config/preview').then(response => response.json())
        : prepareRemoteCatalog(JSON.parse(await fs.readFile(new URL('./seed/model-config.default.json', import.meta.url), 'utf8')));
    await fs.writeFile(seedPath, JSON.stringify(seed));
    const fixture = { checkedAt: new Date().toISOString(), sites: [
        { host: 'art.ravenhash.org', label: '老站', currency: 'USD', exchangeToCny: 6.75, models: [
            { model: 'ch0107-sd-2.5-720p', active: true, status: 'known', currency: 'CNY', prices: [{ label: '', amount: 1.06, unit: 'second' }] }
        ] },
        { host: 'cart.ravenhash.org', label: '新站', currency: 'CNY', exchangeToCny: 1, models: [
            { model: 'ch0107-sd-2.5-720p', active: true, status: 'known', currency: 'CNY', prices: [{ label: '720p', amount: 1.25, unit: 'second' }] }
        ] }
    ] };
    fixture.sites.forEach(site => {
        site.checkedAt = fixture.checkedAt;
        site.models.push({ model: 'minimax-h3', active: true, status: 'known', currency: 'CNY',
            prices: ['480p', '768p', '786p', '1080p', '2k', '4k'].map((label, index) => ({ label, amount: (index + 1) * 0.05, unit: 'second' })) });
    });
    await fs.writeFile(path.join(dataDir, 'admin-model-prices.json'), JSON.stringify(fixture));
    if (useSnapshot) await fs.copyFile(new URL('./seed/admin-model-prices.json', import.meta.url), path.join(dataDir, 'admin-model-prices.json'));
    server = await createConfigServer({ dataDir, seedPath, port: 0, adminPassword: 'prices-smoke-local',
        logger: { log() {}, warn() {}, error() {} } });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}/admin`);
    await page.getByPlaceholder('管理密码').fill('prices-smoke-local');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => !globalThis.document.querySelector('.catalog-price')?.textContent.includes('读取中'));
    await page.getByRole('tab', { name: '表单', exact: true }).click();
    const formCard = page.locator('#modelList [data-model-id="starframe.ch0107-sd-2.5-720p"]');
    await formCard.click();
    assert.deepEqual(await formCard.locator('.catalog-price').allTextContents(),
        [useSnapshot ? '老站价格：720p ¥1.06/秒' : '老站价格：¥1.06/秒', '新站价格：720p ¥1.25/秒']);
    await page.getByRole('tab', { name: '操作模式', exact: true }).click();
    const screenshots = path.resolve('output/playwright');
    await fs.mkdir(screenshots, { recursive: true });
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        const result = await page.evaluate(() => {
            const document = globalThis.document;
            const cards = [...document.querySelectorAll('.catalog-tile[data-catalog-model-id]')];
            return { overflow: document.documentElement.scrollWidth > globalThis.innerWidth,
                clipped: cards.filter(card => [...card.querySelectorAll('.catalog-price,.catalog-source')].some(line => {
                    const outer = card.getBoundingClientRect();
                    const inner = line.getBoundingClientRect();
                    return inner.bottom > outer.bottom + 1 || inner.right > outer.right + 1;
                })).length, prices: cards.every(card => card.querySelectorAll('.catalog-price').length === 2) };
        });
        assert.deepEqual(result, { overflow: false, clipped: 0, prices: true });
        await page.screenshot({ path: path.join(screenshots, `config-two-site-prices-${name}.png`) });
    }
    await page.route('**/admin/model-prices', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.reload();
    await page.waitForFunction(() => globalThis.document.querySelector('.catalog-price')?.textContent === '老站价格：读取失败');
    assert.ok(await page.locator('#addModelBtn').isEnabled());
    assert.deepEqual(errors, []);
    console.log('PASS two-site prices: form/operation, exact units, desktop/mobile, independent load failure.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
