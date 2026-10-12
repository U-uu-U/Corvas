import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConfigServer } from './server.mjs';
import { prepareRemoteCatalog } from '../scripts/prepare-remote-catalog.mjs';
import { getModelPresentation } from '../shared/model-presentation.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-display-name-'));
const id = 'ravenhash-video.sd2.5-route1';
const label = 'Seedance 2.5\uff08Dola\u6e20\u9053\u9ad8\u5cf0\u671f\u52ff\u7528\uff09';
let server;
let browser;
try {
    const seed = prepareRemoteCatalog(JSON.parse(await fs.readFile(new URL('../shared/model-config.default.json', import.meta.url), 'utf8')));
    const target = seed.models.find(entry => entry.id === id);
    target.catalog.enabled = true;
    target.presentation.visible = true;
    const seedPath = path.join(dataDir, 'seed.json');
    await fs.writeFile(seedPath, JSON.stringify(seed));
    server = await createConfigServer({ dataDir, seedPath, port: 0, adminPassword: 'display-name-smoke-local',
        logger: { log() {}, warn() {}, error() {} } });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}/admin`);
    await page.locator('#loginForm input[type=password]').fill('display-name-smoke-local');
    await page.locator('#loginForm button[type=submit]').click();
    await page.locator('#catalogPane').waitFor({ state: 'visible' });
    await page.locator('#formTab').click();
    await page.locator('#modelSearch').fill(id);
    await page.locator(`[data-model-id="${id}"]`).click();
    const nameInput = page.locator('[data-field=label]');
    assert.equal(await nameInput.getAttribute('maxlength'), '80');
    await nameInput.fill(label);
    assert.equal(await page.locator('[data-field=routeLabel]').inputValue(), label);
    await page.locator('#operationTab').click();
    const card = page.locator(`#catalogModels [data-catalog-model-id="${id}"] strong`);
    assert.equal(await card.textContent(), label);
    const output = path.resolve('output/playwright');
    await fs.mkdir(output, { recursive: true });
    for (const [width, height] of [[1440, 1000], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await card.scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
        await page.screenshot({ path: path.join(output, `config-display-name-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#saveBtn').click();
    await page.waitForURL(url => url.searchParams.has('flash'));
    const published = await fetch(`${server.url}/config`).then(response => response.json());
    const result = published.models.find(entry => entry.id === id);
    assert.equal(result.presentation.label, label);
    assert.equal(getModelPresentation(result).routeLabel, label);
    assert.deepEqual(result.catalog, target.catalog);
    assert.deepEqual(result.options, target.options);
    assert.deepEqual(result.pricing, target.pricing);
    assert.deepEqual(result.match, target.match);
    assert.deepEqual(errors, []);
    console.log('PASS display rename: form, operation cards, desktop/mobile, publication and existing canvas presentation.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
