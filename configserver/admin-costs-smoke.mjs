import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConfigServer } from './server.mjs';
import { prepareRemoteCatalog } from '../scripts/prepare-remote-catalog.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-cost-ui-'));
let server;
let browser;
try {
    const seed = prepareRemoteCatalog(JSON.parse(await fs.readFile(new URL('./seed/model-config.default.json', import.meta.url), 'utf8')));
    const seedPath = path.join(dataDir, 'seed.json');
    await fs.writeFile(seedPath, JSON.stringify(seed));
    server = await createConfigServer({ dataDir, seedPath, port: 0, adminPassword: 'costs-ui-local', logger: { log() {}, warn() {}, error() {} } });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}/admin`);
    await page.getByPlaceholder('管理密码').fill('costs-ui-local');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => globalThis.document.querySelector('.catalog-cost')?.textContent !== '成本价：读取中');
    const checkLayout = async () => {
        assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        const bad = await page.locator('.catalog-tile[data-catalog-model-id]').evaluateAll(cards => cards.filter(card => {
            const rect = card.getBoundingClientRect();
            const cost = card.querySelector('.catalog-cost');
            const prices = card.querySelectorAll('.catalog-price');
            return !cost || prices.length !== 2 || cost.getBoundingClientRect().bottom > rect.bottom + 1
                || cost.getBoundingClientRect().right > rect.right + 1;
        }).length);
        assert.equal(bad, 0);
        assert.equal(await page.locator('[data-catalog-group] .catalog-cost').count(), 0);
    };
    const screenshots = path.resolve('output/playwright');
    await fs.mkdir(screenshots, { recursive: true });
    for (const [label, model] of [['backup', 'starframe.ch0107-sd-2.5-720p'], ['tiers', 'ravenhash-video.seedance-2.0-fast']]) {
        await page.getByRole('tab', { name: '表单', exact: true }).click();
        await page.locator(`#modelList [data-model-id="${model}"]`).click();
        assert.ok((await page.locator(`#modelList [data-model-id="${model}"] .catalog-cost`).innerText()).includes('成本价：上游参考价'));
        await page.getByRole('tab', { name: '操作模式', exact: true }).click();
        for (const [size, viewport] of [['desktop', { width: 1440, height: 1100 }], ['mobile', { width: 390, height: 844 }]]) {
            await page.setViewportSize(viewport);
            await checkLayout();
            await page.locator('#catalogModels').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(screenshots, `config-costs-${label}-${size}.png`) });
        }
    }
    const published = await fetch(`${server.url}/config`).then(response => response.json());
    assert.deepEqual(published.models, seed.models);
    assert.deepEqual(errors, []);
    console.log('PASS model costs: separate sale/cost lines, exact model matching, tier wrapping, desktop/mobile, no public CONFIG mutation.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
