const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { normalizeRelayFailure, publicErrorResult } = require('../shared/public-api-error.cjs');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-customer-message-'));
    const server = http.createServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ schemaVersion: 1, revision: 41, catalogMode: 'remote', models: [] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let app;
    try {
        const result = publicErrorResult(normalizeRelayFailure(200, { status: 'failed', task_id: 'fixture-minimax', error: {
            message: '远程图片尺寸或宽高比不符合要求（宽高均需在 256～5760 像素，宽高比需在 0.4～2.5）。https://private.example/media; 成本 ￥1.06'
        } }, { query: true, requestId: 'rh_' + 'c'.repeat(32) }).body);
        result.analysisId = 'ea_' + 'd'.repeat(32);
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile,
            FLOW_API_CATALOG_SMOKE_URL: `http://127.0.0.1:${server.address().port}/config` };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: ['--disable-gpu', path.join(__dirname, 'api-catalog-smoke-entry.cjs')], env });
        let page;
        for (let i = 0; i < 100; i++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        await app.evaluate(({ net }) => {
            const original = net.fetch.bind(net);
            net.fetch = async (url, options) => String(url).startsWith('https://artconfig.ravenhash.org/error-analysis/')
                ? new Response(JSON.stringify({ state: 'ready', cause: '参考图片宽高或比例不符合要求',
                    evidence: '宽高均需在 256~5760 像素', suggestion: '检查参考素材' })) : original(url, options);
        });
        await page.waitForFunction(() => window.__flowCanvasGetModelConfigSnapshot?.().status.origin === 'remote');
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.evaluate(failure => {
            localStorage.setItem('flow-canvas-generation-tasks', JSON.stringify([{
                id: 'message-fixture', kind: 'video', status: 'failed', model: 'minimax-h3', providerName: 'MiniMax H3',
                prompt: 'Fixture video', taskId: failure.taskId, requestId: failure.requestId,
                error: failure.error, errorCode: failure.code, errorDetail: failure, confirmedFailure: true,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), params: {}, sourcePaths: []
            }]));
        }, result);
        await page.reload();
        await page.locator('#agentTaskHistoryBtn').click();
        const history = page.locator('#agentTaskHistory');
        await history.locator('.agent-task-analysis').waitFor();
        const text = await history.innerText();
        assert.match(text, /256~5760.*0\.4~2\.5/s);
        assert.doesNotMatch(text, /private\.example|1\.06|成本/);
        assert.match(text, /AI 排查建议.*检查参考素材/s);
        assert.match(text, /失败/);
        for (const [name, width, height] of [['desktop', 1440, 1000], ['compact', 820, 760]]) {
            await app.evaluate(({ BrowserWindow }, dimensions) => {
                const view = BrowserWindow.getAllWindows().find(window => /index\.html/.test(window.webContents.getURL()));
                view.setContentSize(...dimensions);
            }, [width, height]);
            await page.screenshot({ path: path.join(__dirname, `../output/playwright/customer-message-${name}.png`) });
        }
        assert.deepEqual(errors, []);
        console.log('PASS customer error survives saved task reload and renders dimensions on desktop/compact without private values.');
    } finally {
        await app?.close();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
