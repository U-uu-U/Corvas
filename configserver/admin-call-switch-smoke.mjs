import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConfigServer } from './server.mjs';
import { prepareRemoteCatalog } from '../scripts/prepare-remote-catalog.mjs';
import { isVideoGenerationAvailable } from '../shared/video-generation-availability.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-call-switch-'));
let server;
let browser;
try {
    const seed = prepareRemoteCatalog(JSON.parse(await fs.readFile(new URL('./seed/model-config.default.json', import.meta.url), 'utf8')));
    const targets = seed.models.filter(m => m.id.startsWith('shanhai-video.'));
    for (const entry of targets) { entry.catalog.enabled = true; entry.presentation.visible = true; }
    const seedPath = path.join(dataDir, 'seed.json');
    await fs.writeFile(seedPath, JSON.stringify(seed));
    server = await createConfigServer({ dataDir, seedPath, port: 0, adminPassword: 'call-switch-local', logger: { log() {}, warn() {}, error() {} } });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}/admin`);
    await page.getByPlaceholder('管理密码').fill('call-switch-local');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const group = page.locator('#catalogGroups [data-catalog-group="video:shanhai-backup-2"]');
    await group.click();
    assert.equal(await page.locator('[data-field="catalogEnabled"]').isVisible(), false);
    assert.equal(await page.locator('select[data-field="catalogEnabled"]').count(), 0);
    assert.equal(await page.locator('#catalogModels .catalog-call-switch').count(), 4);
    for (const target of targets) await page.locator(`#catalogModels [data-call-model-id="${target.id}"]`).click();
    assert.ok((await group.innerText()).includes('分组停用'));
    assert.equal(await page.locator('#catalogModels .catalog-call-switch[aria-checked=false]').count(), 4);
    assert.equal(await page.locator('#catalogModels button button').count(), 0);
    const draft = JSON.parse(await page.locator('#configText').inputValue());
    assert.ok(draft.models.filter(m => m.id.startsWith('shanhai-video.')).every(m => m.catalog.enabled === false && m.presentation.visible === true));
    for (const target of targets) assert.equal(isVideoGenerationAvailable({ endpoint: 'https://art.ravenhash.org/v1', model: target.catalog.model }, draft), false);
    await page.locator('[data-field="catalogHosts"]').fill('art.ravenhash.org\ncart.ravenhash.org\nshanhai.vnshu.cn\n');
    assert.ok(JSON.parse(await page.locator('#configText').inputValue()).models
        .filter(m => m.id.startsWith('shanhai-video.')).every(m => m.catalog.enabled === false), 'Editing hosts must preserve the hidden call state');
    await page.locator('#saveBtn').click();
    await page.waitForURL('**/admin?flash=*');
    const published = await fetch(`${server.url}/config`).then(r => r.json());
    assert.ok(published.models.filter(m => m.id.startsWith('shanhai-video.')).every(m => m.catalog.enabled === false));
    await group.click();
    await page.locator(`#catalogModels [data-call-model-id="${targets[0].id}"]`).press('Space');
    assert.equal(await page.locator('#catalogModels .catalog-call-switch[aria-checked=true]').count(), 1);
    assert.ok((await group.innerText()).includes('部分停用'));
    await page.locator('#catalogSearch').fill('山海');
    await page.locator('#catalogSearch').fill('');
    await group.click();
    await page.locator(`#catalogModels [data-catalog-model-id="${targets[0].id}"]`).click();
    await page.locator(`#catalogModels [data-catalog-model-id="${targets[0].id}"]`).press('ArrowDown');
    assert.equal(await page.locator('#selectedModelId').textContent(), targets[1].id);
    const screenshots = path.resolve('output/playwright');
    await fs.mkdir(screenshots, { recursive: true });
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1050 }], ['mobile', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        await page.locator('#catalogModels').scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        assert.ok(await page.locator('#catalogModels .catalog-item').evaluateAll(items => items.every(item => {
            const control = item.querySelector('.catalog-call-control').getBoundingClientRect();
            const title = item.querySelector('strong').getBoundingClientRect();
            return control.bottom <= title.top;
        })));
        await page.screenshot({ path: path.join(screenshots, `config-call-switch-${name}.png`) });
    }
    assert.deepEqual(errors, []);
    console.log('PASS card call switches: all four models, keep disabled cards/groups, publish and block submissions, keyboard, desktop/mobile.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
