import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConfigServer } from './server.mjs';
import { createAdminBalances } from './lib/admin-balances.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-balance-ui-'));
let server;
let browser;
try {
    await fs.writeFile(path.join(dataDir, 'admin-balance-credentials.json'), JSON.stringify({ 'zhubo-art': { key: 'local-test-only' } }));
    const balances = createAdminBalances({ dataDir, seedPath: new URL('./seed/admin-balance-accounts.json', import.meta.url),
        fetchImpl: async () => ({ ok: true, json: async () => ({ billing: true, balance: 44.35 }) }) });
    server = await createConfigServer({ dataDir, balances, port: 0, adminPassword: 'balance-ui-local',
        logger: { log() {}, warn() {}, error() {} } });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}/admin`);
    await page.getByPlaceholder('管理密码').fill('balance-ui-local');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => globalThis.document.getElementById('balanceState').textContent.includes('1 / 8'));
    assert.equal(await page.locator('#balanceRows tr').count(), 8);
    assert.equal(await page.locator('#balanceRows tr[data-low=true]').count(), 1);
    assert.ok((await page.locator('#balanceRows').innerText()).includes('44.35'));
    const threshold = page.getByLabel('主播视频低余额预警线', { exact: true });
    await threshold.fill('30');
    await threshold.press('Tab');
    await page.waitForFunction(() => globalThis.document.querySelector('#balanceRows tr').dataset.low === 'false');
    await page.reload();
    await threshold.waitFor();
    assert.equal(await threshold.inputValue(), '30');
    await threshold.fill('50');
    await threshold.press('Tab');
    await page.waitForFunction(() => globalThis.document.querySelector('#balanceRows tr').dataset.low === 'true');
    await page.getByRole('button', { name: '刷新余额', exact: true }).click();
    await page.waitForFunction(() => !globalThis.document.getElementById('refreshBalancesBtn').disabled);
    const screenshots = path.resolve('output/playwright');
    await fs.mkdir(screenshots, { recursive: true });
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        await page.locator('#balanceSection').scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        await page.screenshot({ path: path.join(screenshots, `config-balances-side-${name}.png`) });
    }
    const config = await fetch(`${server.url}/config`).then(response => response.text());
    assert.ok(!config.includes('local-test-only'));
    assert.deepEqual(errors, []);
    console.log('PASS balances: live rendering, threshold save/reload, refresh, desktop/mobile, private credentials.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
