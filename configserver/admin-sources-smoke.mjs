import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConfigServer } from './server.mjs';
import { prepareRemoteCatalog } from '../scripts/prepare-remote-catalog.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-sources-'));
let server;
let browser;
try {
    const seedPath = path.join(dataDir, 'seed.json');
    const seed = prepareRemoteCatalog(JSON.parse(await fs.readFile(new URL('./seed/model-config.default.json', import.meta.url), 'utf8')));
    await fs.writeFile(seedPath, JSON.stringify(seed));
    server = await createConfigServer({ dataDir, seedPath, port: 0, adminPassword: 'sources-smoke-local',
        logger: { log() {}, warn() {}, error() {} } });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}/admin`);
    await page.getByPlaceholder('管理密码').fill('sources-smoke-local');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => globalThis.document.querySelector('.catalog-source-name')?.textContent !== '上游：读取中');
    const starframe = page.locator('#modelList [data-model-id="starframe.ch0107-sd-2.5-720p"]');
    await page.getByRole('tab', { name: '表单', exact: true }).click();
    await starframe.click();
    assert.equal(await starframe.locator('.catalog-source-name').textContent(), '上游：StarFrame');
    assert.equal(await starframe.locator('.catalog-source-url').textContent(), 'URL：https://api.xzapi.vip');
    await page.getByRole('tab', { name: '操作模式', exact: true }).click();
    const assertLayout = async () => {
        const result = await page.evaluate(() => {
            const document = globalThis.document;
            const cards = [...document.querySelectorAll('.catalog-tile[data-catalog-model-id]')];
            return { overflow: document.documentElement.scrollWidth > globalThis.innerWidth,
                clipped: cards.filter(card => [...card.querySelectorAll('.catalog-price,.catalog-source')].some(line => {
                    const outer = card.getBoundingClientRect();
                    const inner = line.getBoundingClientRect();
                    return inner.bottom > outer.bottom + 1 || inner.right > outer.right + 1;
                })).length,
                annotated: cards.every(card => card.querySelectorAll('.catalog-source').length === 2),
                groupSources: document.querySelectorAll('[data-catalog-group] .catalog-source').length };
        });
        assert.deepEqual(result, { overflow: false, clipped: 0, annotated: true, groupSources: 0 });
    };
    const screenshots = path.resolve('output/playwright');
    await fs.mkdir(screenshots, { recursive: true });
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        await assertLayout();
        await page.evaluate(() => globalThis.scrollTo(0, 0));
        await page.screenshot({ path: path.join(screenshots, `config-sources-side-${name}.png`) });
    }
    await page.route('**/admin/model-sources', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.reload();
    await page.waitForFunction(() => globalThis.document.querySelector('.catalog-source-name')?.textContent === '上游：读取失败');
    assert.ok(await page.locator('#addModelBtn').isEnabled());
    assert.deepEqual(errors, []);
    console.log('PASS source labels: form/operation, desktop/mobile, wrapped URLs, isolated load failure.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
