const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
if (process.env.FLOW_ERROR_REPORT_SMOKE_ENTRY === '1' && process.versions.electron) {
    require('./api-catalog-smoke-entry.cjs');
    require('../electron-main/diagnostics.cjs').diagnostic('error', 'ipc.end', {
        requestId: `rh_${'b'.repeat(32)}`, clientTaskId: 'client-fixture', model: 'cart-fixture', site: 'cart', error: 'cart fixture failure',
    });
} else {
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-error-report-'));
    const artifacts = path.join(__dirname, '../output/playwright');
    const configServer = http.createServer((_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ schemaVersion: 1, revision: 41, catalogMode: 'remote', models: [] }));
    });
    await new Promise(resolve => configServer.listen(0, '127.0.0.1', resolve));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        await fs.mkdir(artifacts, { recursive: true });
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'report-fixture', items: [],
            folderGroups: [{ id: 'report-fixture', name: 'Report fixture', savedItems: [], connections: [], folders: [], boardRevision: 0 }], mcp: { enabled: false } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile, FLOW_ERROR_REPORT_SMOKE_ENTRY: '1',
            FLOW_API_CATALOG_SMOKE_URL: `http://127.0.0.1:${configServer.address().port}/config` };
        delete env.ELECTRON_RUN_AS_NODE;
        const launch = async failFirst => {
            app = await electron.launch({ executablePath: require('electron'),
                args: ['--disable-gpu', __filename], env });
            app.process().stderr.on('data', data => { if (/Error:|Cannot find/.test(String(data))) process.stderr.write(data); });
            let page;
            for (let attempt = 0; attempt < 100; attempt++) {
                page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
                if (page) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.ok(page, 'Canvas window must load');
            await page.waitForFunction(() => window.flowCanvas?.diagnostics?.submit && document.querySelector('#diagnosticsReportDialog'));
            await app.evaluate(({ net }, shouldFail) => {
                globalThis.errorReportSmoke = { requests: [] };
                const original = net.fetch.bind(net);
                net.fetch = async (url, options) => {
                    if (url !== 'https://artconfig.ravenhash.org/error-reports') return original(url, options);
                    globalThis.errorReportSmoke.requests.push({ url, body: options.body, redirect: options.redirect });
                    if (shouldFail && globalThis.errorReportSmoke.requests.length === 1) throw new Error('fixture receipt lost after acceptance');
                    return new Response(JSON.stringify({ success: true, reportId: `er_${'a'.repeat(32)}`,
                        receivedAt: new Date().toISOString(), private: 'must never reach renderer' }));
                };
            }, failFirst);
            return page;
        };
        let page = await launch(true);
        let dialog = page.locator('#diagnosticsReportDialog');
        const openArt = () => page.evaluate(() => document.dispatchEvent(new CustomEvent('diagnostics:report', {
            detail: { requestId: `rh_${'c'.repeat(32)}`, clientTaskId: 'art-fixture', model: 'art-fixture', site: 'art' },
        })));
        await openArt();
        await page.waitForFunction(() => !document.querySelector('[data-report-submit]').disabled);
        await dialog.locator('[name=description]').fill('Art draft');
        const cartOption = await dialog.locator('[name=errorRecord] option').filter({ hasText: 'cart-fixture' }).getAttribute('value');
        await dialog.locator('[name=errorRecord]').selectOption(cartOption);
        assert.equal(await dialog.locator('[name=site]').inputValue(), 'cart');
        await dialog.locator('[name=description]').fill('Cart draft');
        await dialog.locator('[data-report-close]').click();
        await openArt();
        await page.waitForFunction(() => !document.querySelector('[data-report-submit]').disabled);
        assert.equal(await dialog.locator('[name=site]').inputValue(), 'art');
        assert.equal(await dialog.locator('[name=description]').inputValue(), 'Art draft');
        await dialog.locator('[name=site]').selectOption('cart');
        await dialog.locator('[data-report-close]').click();
        await openArt();
        await page.waitForFunction(() => !document.querySelector('[data-report-submit]').disabled);
        assert.equal(await dialog.locator('[name=site]').inputValue(), 'cart', 'Explicit site override belongs to its own error draft');
        await dialog.locator('[data-report-close]').click();
        await page.evaluate(async () => {
            await window.flowCanvas.apiConfig.save({ version: 1, revision: 100, providers: [{ id: 'fixture', name: 'Fixture',
                type: 'openai', capability: 'image', endpoint: 'https://cart.ravenhash.org/v1', model: 'fixture', apiKey: 'private-fixture-key' }], globalConfig: {} });
            console.error('Error report fixture private-fixture-key');
            document.dispatchEvent(new CustomEvent('diagnostics:report', { detail: {
                requestId: `rh_${'b'.repeat(32)}`, clientTaskId: 'client-fixture', model: 'sd2-fast', site: 'cart',
                error: '视频时长超出范围，请调整后重试。', params: { duration: 15, resolution: '720p' },
                prompt: 'private prompt must be omitted',
            } }));
        });
        await dialog.waitFor({ state: 'visible' });
        await page.waitForFunction(() => !document.querySelector('[data-report-submit]').disabled);
        assert.equal(await dialog.locator('[name=site]').inputValue(), 'cart');
        await dialog.locator('[name=description]').fill('选择 15 秒生成时提示超出范围。');
        await dialog.locator('[name=contact]').fill('fixture@example.invalid');
        await dialog.locator('[data-report-close]').click();
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('diagnostics:report', {
            detail: { requestId: `rh_${'b'.repeat(32)}`, clientTaskId: 'client-fixture', model: 'sd2-fast', site: 'cart' },
        })));
        assert.equal(await dialog.locator('[name=description]').inputValue(), '选择 15 秒生成时提示超出范围。');
        await page.waitForFunction(() => !document.querySelector('[data-report-submit]').disabled);
        await page.screenshot({ path: path.join(artifacts, 'error-report-desktop.png') });
        await dialog.locator('[data-report-submit]').click();
        await page.waitForFunction(() => document.querySelector('.diagnostics-report-status').textContent.includes('无法连接'));
        assert.equal(await dialog.locator('[name=description]').isDisabled(), true);
        const beforeRestartRequests = await app.evaluate(() => globalThis.errorReportSmoke.requests);
        const pending = await page.evaluate(() => window.flowCanvas.diagnostics.summary());
        assert.equal(pending.submissions[0].state, 'pending');
        assert.equal('diagnostic' in pending.submissions[0], false);
        await app.close(); app = null;
        page = await launch(false);
        dialog = page.locator('#diagnosticsReportDialog');
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('diagnostics:report', {
            detail: { requestId: `rh_${'b'.repeat(32)}`, clientTaskId: 'client-fixture', model: 'sd2-fast', site: 'cart' },
        })));
        await page.waitForFunction(() => document.querySelector('.diagnostics-report-status').textContent.includes('尚未确认'));
        assert.equal(await dialog.locator('[name=description]').inputValue(), '选择 15 秒生成时提示超出范围。');
        assert.equal(await dialog.locator('[name=contact]').inputValue(), 'fixture@example.invalid');
        await dialog.locator('[data-report-submit]').click();
        await page.waitForFunction(() => document.querySelector('.diagnostics-report-status').textContent.includes('已收到'));
        await dialog.locator('[data-report-copy]').click();
        assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), `er_${'a'.repeat(32)}`);
        const requests = [...beforeRestartRequests, ...await app.evaluate(() => globalThis.errorReportSmoke.requests)];
        assert.equal(requests.length, 2);
        assert.equal(requests[0].body, requests[1].body);
        assert.equal(requests[0].redirect, 'error');
        assert.equal(requests[0].body.includes('private-fixture-key'), false);
        assert.equal(requests[0].body.includes('private prompt must be omitted'), false);
        const payload = JSON.parse(requests[0].body);
        assert.equal(payload.site, 'cart');
        assert.equal(payload.requestId, `rh_${'b'.repeat(32)}`);
        assert.ok(payload.diagnostic.events.length);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setContentSize(760, 640));
        await page.screenshot({ path: path.join(artifacts, 'error-report-compact.png') });
        assert.equal(await dialog.evaluate(element => {
            const box = element.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
                && element.scrollWidth <= element.clientWidth;
        }), true);
        await app.close(); app = null;
        page = await launch(false);
        dialog = page.locator('#diagnosticsReportDialog');
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('diagnostics:report', {
            detail: { requestId: `rh_${'b'.repeat(32)}`, clientTaskId: 'client-fixture', model: 'sd2-fast', site: 'cart' },
        })));
        await page.waitForFunction(() => document.querySelector('.diagnostics-report-status').textContent.includes('已收到'));
        assert.equal(await dialog.locator('[data-report-submit]').isDisabled(), true);
        assert.equal(await app.evaluate(() => globalThis.errorReportSmoke.requests.length), 0);
        await dialog.locator('[data-report-close]').click();
        await page.locator('#agentSettingsBtn').click();
        await page.locator('#agentApiSettingsTab').click();
        await page.locator('#diagnosticsSettings summary').click();
        await page.locator('[data-debug=submit]').click();
        await dialog.waitFor({ state: 'visible' });
        assert.equal(await dialog.locator('[name=description]').inputValue(), '');
        console.log('PASS error-report client: task/settings entry, per-error site/draft, manual override, restart pending/receipt recovery, exact retry dedupe, redaction, clipboard, compact layout; no real reports or generation.');
    } finally {
        await app?.close();
        await new Promise(resolve => configServer.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
}
