import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const admin = 'http://127.0.0.1:18087';
const bridge = 'http://127.0.0.1:18766';
const password = process.env.CONFIG_LAB_PASSWORD;
if (!password) throw new Error('CONFIG_LAB_PASSWORD is required');
const login = await fetch(`${admin}/admin/login`, { method: 'POST',
    body: new URLSearchParams({ username: 'admin', password }), redirect: 'manual' });
assert.equal(login.status, 303);
const cookie = login.headers.get('set-cookie').split(';')[0];
const publish = async config => {
    const html = await fetch(`${admin}/admin`, { headers: { cookie } }).then(response => response.text());
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    const response = await fetch(`${admin}/admin/save`, { method: 'POST', headers: { cookie },
        body: new URLSearchParams({ csrf, content: JSON.stringify(config), note: 'Source catalog experiment' }), redirect: 'manual' });
    assert.equal(response.status, 303);
    const refreshed = await fetch(`${bridge}/model-config/refresh`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{}' }).then(response => response.json());
    assert.equal(refreshed.success, true);
    assert.equal(refreshed.status.catalogMode, 'remote');
    return refreshed.status;
};

const browser = await chromium.connectOverCDP('http://127.0.0.1:9229');
const page = browser.contexts()[0].pages().find(page => page.url().startsWith('http://127.0.0.1:15321'));
assert.ok(page, 'Source lab renderer is open');
await page.waitForFunction(() => globalThis.Konva?.stages[0]?.findOne('#catalog-video'));
const accounts = await page.evaluate(async () => {
    const loaded = await globalThis.flowCanvas.apiConfig.load();
    return { count: loaded.config.providers.length,
        localModels: loaded.config.providers.reduce((count, provider) => count + (provider.models?.length || 0), 0) };
});
assert.ok(accounts.count > 0);
assert.equal(accounts.localModels, 0);
await publish({ schemaVersion: 1, catalogMode: 'remote', models: [] });
await page.evaluate(() => globalThis.Konva.stages[0].findOne('#catalog-video').fire('click', { evt: { button: 0 } }));
await page.locator('[data-model]').click();
assert.equal(await page.locator('.generation-composer-model-option').count(), 0);
await fs.mkdir('output/playwright', { recursive: true });
await page.screenshot({ path: 'output/playwright/catalog-source-empty.png' });
const config = JSON.parse(await fs.readFile('output/config-catalog-lab/remote-catalog.json', 'utf8'));
const status = await publish(config);
await page.waitForFunction(() => document.querySelectorAll('.generation-composer-model-option').length > 0);
const titles = await page.locator('.generation-composer-route-trigger strong').allTextContents();
assert.ok(titles.includes('Seedance 2.5 推荐渠道'));
assert.ok(titles.includes('Seedance 2.5 备用渠道'));
assert.ok(titles.includes('Seedance 2.0 推荐渠道'));
assert.ok(!titles.includes('备用分组2'));
const backup = page.locator('.generation-composer-route-trigger').filter({ hasText: 'Seedance 2.5 备用渠道' }).first();
await backup.hover();
await page.waitForFunction(() => Array.from(document.querySelectorAll('.generation-composer-route-panel'))
    .some(panel => panel.matches(':popover-open') && Number(getComputedStyle(panel).opacity) >= 0.99));
await page.screenshot({ path: 'output/playwright/catalog-source-remote.png' });
console.log(JSON.stringify({ accounts: accounts.count, localModels: accounts.localModels,
    appliedRevision: status.revision, remoteEntries: status.modelCount, groups: titles,
    visibleModels: await page.locator('.generation-composer-model-option').count() }));
// This attaches to the user's persistent lab window; exiting disconnects the test transport only.
process.exit(0);
