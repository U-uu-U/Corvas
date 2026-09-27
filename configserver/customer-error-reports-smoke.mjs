/* global document, innerWidth */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createConfigServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-customer-reports-ui-'));
let server;
let browser;
try {
    let lookups = 0;
    server = await createConfigServer({ dataDir, port: 0, adminPassword: 'fixture-customer-reports', logger: { log() {}, warn() {}, error() {} },
        requestDiagnostics: { async get(site, requestId) {
            lookups++;
            return { status: 200, body: { record: { site, requestId, request: { model: 'sd2-fast', duration: 15, resolution: '720p' },
                upstreamStatus: 400, error: { code: 'invalid_duration', message: 'duration must be between 1 and 12 seconds' },
                relayLog: { state: 'found', rows: [{ cost: 0, billing_detail: '请求未受理' }] } } } };
        } } });
    const submission = { formatVersion: 1, submissionId: crypto.randomUUID(), site: 'cart', requestId: `rh_${'a'.repeat(32)}`,
        description: '720p 选择 15 秒后提交失败，模型显示参数错误。', contact: 'customer@example.test',
        context: { model: 'sd2-fast', taskId: 'fixture-task' }, diagnostic: { environment: { platform: 'win32', appVersion: 'fixture' },
            tasks: [{ id: 'fixture-task', requestId: `rh_${'a'.repeat(32)}`, error: '参数错误' }], events: [] } };
    const submitted = await fetch(`${server.url}/error-reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
    assert.equal(submitted.status, 200);
    const receipt = await submitted.json();
    await server.customerReports.waitForIdle();
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${server.url}/admin`);
    await page.getByPlaceholder('管理密码').fill('fixture-customer-reports');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('#customerReportRows button').first().click();
    await page.waitForFunction(() => !document.getElementById('customerReportDetail').hidden);
    assert.equal(await page.locator('#customerReportTitle').innerText(), receipt.reportId);
    assert.match(await page.locator('#customerReportEvidence').innerText(), /invalid_duration/);
    await page.getByLabel('处理状态', { exact: true }).selectOption('investigating');
    await page.getByLabel('管理员备注', { exact: true }).fill('已确认时长限制，等待客户重试。');
    await page.getByRole('button', { name: '保存处理记录', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('customerReportActionStatus').textContent === '已保存');
    assert.equal(server.customerReports.get(receipt.reportId).status, 'investigating');
    await page.getByRole('button', { name: '补查服务端记录', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('customerReportActionStatus').textContent === '补查完成');
    assert.equal(lookups, 2);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载脱敏 JSON', exact: true }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), `${receipt.reportId}.json`);
    await page.getByLabel('错误提交状态', { exact: true }).selectOption('resolved');
    await page.waitForFunction(() => document.getElementById('customerReportRows').textContent.includes('暂无符合条件'));
    await page.getByLabel('错误提交状态', { exact: true }).selectOption('investigating');
    await page.waitForFunction(() => Boolean(document.querySelector('#customerReportRows button')));
    await fs.mkdir('output/playwright', { recursive: true });
    for (const [name, width] of [['desktop', 1440], ['mobile', 390]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator('#customerErrorReports').scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `output/playwright/customer-error-reports-${name}.png` });
    }
    assert.deepEqual(pageErrors, []);
    console.log('PASS customer error inbox: submit, list, detail, notes/status, refresh, download, filters, desktop/mobile.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
