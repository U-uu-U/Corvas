import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createConfigServer } from '../configserver/server.mjs';
import { hashPassword } from '../configserver/lib/auth.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-admin-'));
const password = 'local-admin-smoke';
let server;
let browser;
try {
    server = await createConfigServer({ dataDir, host: '127.0.0.1', port: 0, passwordRecord: hashPassword(password),
        logger: { log() {}, warn() {}, error() {} } });
    const original = structuredClone(server.store.current());
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`${server.url}/admin`);
    await page.getByPlaceholder('管理密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('#formPane').waitFor({ state: 'visible' });
    assert.deepEqual(JSON.parse(await page.locator('#configText').inputValue()), original.config);
    const modelId = 'ravenhash-video.sd2.5-route1';
    const select = async id => {
        await page.locator('#modelSearch').fill(id);
        await page.locator(`button[data-model-id="${id}"]`).click();
    };
    await select(modelId);
    const field = key => page.locator(`[data-field="${key}"]`);
    await field('label').fill('Seedance 2.5 测试名称');
    await field('description').fill('固定 30 秒，支持多张参考图');
    await field('amount').fill('6.5');
    await field('recommended').selectOption('false');
    let edited = JSON.parse(await page.locator('#configText').inputValue());
    const target = edited.models.find(model => model.id === modelId);
    assert.equal(target.pricing.amount, 6.5);
    assert.equal(target.pricing.currency, 'CNY');
    assert.equal(target.presentation.recommended, false);
    assert.deepEqual(target.options, original.config.models.find(model => model.id === modelId).options);
    assert.deepEqual(edited.models.filter(model => model.id !== modelId), original.config.models.filter(model => model.id !== modelId));
    await select('ravenhash-image.gpt-image-2');
    await field('label').fill('图像主线路');
    await page.getByRole('button', { name: '还原此模型', exact: true }).click();
    const restoredImage = JSON.parse(await page.locator('#configText').inputValue());
    assert.deepEqual(restoredImage.models[0], original.config.models[0]);
    assert.equal(restoredImage.models.find(model => model.id === modelId).pricing.amount, 6.5);
    await field('label').fill('图像主线路');
    await select(modelId);
    assert.equal(await field('amount').inputValue(), '6.5');

    await page.getByRole('tab', { name: 'JSON', exact: true }).click();
    edited = JSON.parse(await page.locator('#configText').inputValue());
    edited.models[0].futureField = { keep: true };
    const validText = JSON.stringify(edited, null, 2);
    await page.locator('#configText').fill('{invalid');
    await page.getByRole('tab', { name: '表单', exact: true }).click();
    assert.equal(await page.locator('#jsonPane').isVisible(), true);
    assert.equal(await page.locator('#configText').inputValue(), '{invalid');
    await page.locator('#configText').fill(validText);
    await page.getByRole('tab', { name: '表单', exact: true }).click();
    assert.equal(await field('label').inputValue(), 'Seedance 2.5 测试名称');
    await field('amount').fill('');
    await page.getByRole('tab', { name: 'JSON', exact: true }).click();
    assert.equal(await page.locator('#formPane').isVisible(), true);
    await field('amount').fill('6.5');
    await field('priceMode').selectOption('unknown');
    assert.equal(JSON.parse(await page.locator('#configText').inputValue()).models.find(model => model.id === modelId).pricing.status, 'unknown');
    await field('priceMode').selectOption('known');
    await field('amount').fill('6.5');
    await page.getByRole('button', { name: '校验', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('editorState').textContent.includes('校验通过'));
    const screenshots = path.join(root, 'output', 'playwright');
    await fs.mkdir(screenshots, { recursive: true });
    await page.locator('#modelSearch').fill('');
    const assertPublishBarLayout = async () => {
        for (const scrollTop of [0, 500, 10000]) {
            const layout = await page.evaluate(top => {
                window.scrollTo(0, top);
                const pane = document.querySelector('#formPane[hidden]') ? '#jsonPane' : '#formPane';
                return {
                    editorBottom: document.querySelector(pane).getBoundingClientRect().bottom,
                    barTop: document.querySelector('.publish-bar').getBoundingClientRect().top,
                    overflow: document.documentElement.scrollWidth > window.innerWidth,
                };
            }, scrollTop);
            assert.ok(layout.barTop >= layout.editorBottom - 1, 'Publish bar must stay below the editor at every scroll position');
            assert.equal(layout.overflow, false, 'Page must not overflow horizontally');
        }
        await page.evaluate(() => window.scrollTo(0, 0));
    };
    await assertPublishBarLayout();
    await page.screenshot({ path: path.join(screenshots, 'config-admin-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 900, height: 600 });
    await assertPublishBarLayout();
    await page.getByRole('tab', { name: 'JSON', exact: true }).click();
    await assertPublishBarLayout();
    await page.getByRole('tab', { name: '表单', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await assertPublishBarLayout();
    assert.equal(await field('label').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    await page.screenshot({ path: path.join(screenshots, 'config-admin-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 1000 });
    await page.locator('input[name="draft"]').check();
    await page.getByLabel('变更说明').fill('form smoke draft');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForURL('**/admin?flash=*');
    assert.deepEqual(server.store.current().config, original.config);
    const draft = server.store.list().find(version => !version.current);
    assert.ok(draft, 'A draft version is created');
    await page.locator(`a[href="/admin?version=${draft.name}"]`).click();
    await page.locator('#formPane').waitFor({ state: 'visible' });
    await select(modelId);
    assert.equal(await field('amount').inputValue(), '6.5');
    await page.getByRole('button', { name: '发布配置', exact: true }).click();
    await page.waitForURL('**/admin?flash=*');
    const published = (await (await fetch(`${server.url}/config`)).json());
    assert.equal(published.models.find(model => model.id === modelId).pricing.amount, 6.5);
    assert.deepEqual(published.models[0].futureField, { keep: true });
    await page.locator(`form[action="/admin/apply"]:has(input[value="${original.name}"]) button`).click();
    await page.waitForURL('**/admin?flash=*');
    assert.deepEqual(server.store.current().config, original.config);

    await page.getByRole('tab', { name: 'JSON', exact: true }).click();
    await page.locator('#configText').fill('{"schemaVersion":1,"models":[]}');
    await page.locator('input[name="draft"]').check();
    await page.getByLabel('变更说明').fill('keep rejected draft');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForURL('**/admin/save');
    assert.equal(await page.locator('input[name="draft"]').isChecked(), true);
    assert.equal(await page.getByLabel('变更说明').inputValue(), 'keep rejected draft');
    assert.equal(await page.locator('#configText').inputValue(), '{"schemaVersion":1,"models":[]}');
    assert.deepEqual(server.store.current().config, original.config);
    assert.deepEqual(errors, []);
    console.log('PASS config admin: login, forms/JSON, validation, isolated edits, currencies, draft, publish, rollback, rejected input, desktop/mobile.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
