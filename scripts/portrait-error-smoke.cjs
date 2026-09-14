const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const scenarios = {
        portrait: { reason: 'For 肖像保护, Dreamina Seedance 2.5 只支持生成包含您自己的视频. 请换一张参考图, or create a video from text。', code: 'RH_PORTRAIT_SELF_REQUIRED', text: '本人肖像', label: '肖像保护限制' },
        copyright: { reason: '素材图片包含版权内容，审核未通过', code: 'RH_REFERENCE_COPYRIGHT', text: '版权保护', label: '参考素材版权限制' },
        content: { reason: '内容审核未通过，请修改后重试', code: 'RH_CONTENT_REJECTED', text: '内容审核未通过', label: '内容审核未通过' }
    };
    const scenarioName = process.env.FLOW_ERROR_SCENARIO || 'portrait';
    assert.ok(Object.hasOwn(scenarios, scenarioName));
    const scenario = scenarios[scenarioName];
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-portrait-'));
    const requests = [];
    const reason = scenario.reason;
    const server = http.createServer((req, res) => {
        requests.push({ method: req.method, url: req.url });
        req.resume();
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: { id: 'portrait-remote', status: 'failed', fail_reason: reason } }));
        });
    });
    let app;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
        await fs.mkdir(path.join(profile, 'data'));
        const items = [{ id: 'portrait-node', kind: 'op', nodeType: 'video', x: 180, y: 160, width: 480, height: 270,
            config: { providerId: 'video', sourceProviderId: 'video', model: 'sd2.5-route1', prompt: 'portrait test', duration: 30, resolution: '720p', ratio: '16:9', count: 1 } }];
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'portrait-project', items,
            folderGroups: [{ id: 'portrait-project', name: 'Portrait rejection', folders: [], savedItems: items, connections: [] }], mcp: { enabled: false } }));
        await fs.writeFile(path.join(profile, 'fixture-api.json'), JSON.stringify({ version: 1, revision: 1,
            providers: [{ id: 'video', type: 'openai', capability: 'video', endpoint, model: 'sd2.5-route1', apiKey: 'test-only' }],
            globalConfig: { videoProviderId: 'video' } }));
        const env = { ...process.env, FLOW_CANVAS_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.FLOW_CANVAS_SMOKE_LIVE;
        delete env.FLOW_CANVAS_SMOKE_ASAR;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'agent-smoke-entry.cjs')], env });
        let page;
        for (let i = 0; i < 150; i++) {
            page = app.windows().find(window => window.url().startsWith('http://127.0.0.1:15321'));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'Vite must be running on port 15321');
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#portrait-node'));
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('context-run-node', { detail: { nodeId: 'portrait-node' } })));
        await page.waitForFunction(expected => {
            const node = window.Konva.stages[0].findOne('#portrait-node');
            return node.find('Text').some(text => text.text().includes(expected));
        }, scenario.text);
        const state = await page.evaluate(async () => {
            const node = window.Konva.stages[0].findOne('#portrait-node');
            return { labels: node.find('Text').map(text => text.text()), recoveryControls: node.find('.generationRecoveryControl').length,
                records: await window.flowCanvas.mcp.listRecoverableGenerations() };
        });
        assert.equal(state.recoveryControls, 0);
        assert.doesNotMatch(state.labels.join(' '), /Dreamina|服务暂时不可用/);
        const record = state.records.find(entry => entry.taskId === 'portrait-remote');
        assert.equal(record.confirmedFailure, true);
        assert.equal(record.state, 'failed');
        assert.equal(record.errorCode, scenario.code);
        assert.deepEqual(requests, [{ method: 'POST', url: '/v1/video/generations' }]);
        await page.locator('#agentTaskHistoryBtn').click();
        assert.ok((await page.locator('.agent-task-item').innerText()).includes(scenario.label));
        assert.equal(await page.locator('.agent-task-item > .agent-task-recovery [data-recover-task]').count(), 0);
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        await page.screenshot({ path: path.join(output, `${scenarioName}-error.png`) });
        console.log(`${scenarioName} rejection passed: actual IPC, node error, no recovery button, task history, durable failure and a single local mock request.`);
    } finally {
        await app?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('corvas-portrait-'));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
