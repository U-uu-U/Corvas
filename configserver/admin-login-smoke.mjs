import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConfigServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-login-'));
let server;
let browser;
try {
    server = await createConfigServer({ dataDir, port: 0, adminPassword: 'login-local-check', logger: { log() {}, warn() {}, error() {} } });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${server.url}/admin?channel=preview`);
    assert.equal(await page.getByLabel('账号', { exact: true }).inputValue(), 'admin');
    assert.equal(await page.getByLabel('账号', { exact: true }).getAttribute('autocomplete'), 'username');
    assert.equal(await page.getByLabel('密码', { exact: true }).getAttribute('autocomplete'), 'current-password');
    const screenshots = path.resolve('output/playwright');
    await fs.mkdir(screenshots, { recursive: true });
    for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        await page.screenshot({ path: path.join(screenshots, `config-login-admin-${name}.png`) });
    }
    await page.getByLabel('账号', { exact: true }).fill('other');
    await page.getByLabel('密码', { exact: true }).fill('login-local-check');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/admin/login?error=1&channel=preview');
    assert.ok(await page.getByText('账号或密码不正确', { exact: true }).isVisible());
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('login-local-check');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/admin?channel=preview');
    await page.locator('#catalogPane').waitFor({ state: 'visible' });
    console.log('PASS admin username/password login, autofill attributes, wrong username rejection, preview return, desktop/mobile.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
