const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const tool = (id, name, args) => ({ id, type: 'function', function: {
    name: `t_${crypto.createHash('sha256').update(name).digest('hex').slice(0, 60)}`,
    arguments: JSON.stringify(args)
} });

(async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-agent-citations-'));
    const profile = path.join(directory, 'profile');
    let app;
    const failures = [];
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const outputs = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
        let message = { role: 'assistant', content: '素材已标注，提示词中的胶囊已绑定到素材。' };
        if (outputs.some(result => result.error)) failures.push(...outputs.filter(result => result.error));
        if (!outputs.length) message = { role: 'assistant', content: '', tool_calls: [
            tool('snapshot', 'flow_canvas.board.get_snapshot', { scope: 'project' })
        ] };
        else if (!outputs.some(result => result.undoToken)) message = { role: 'assistant', content: '', tool_calls: [
            tool('edit', 'flow_canvas.board.transaction.apply', { id: 'annotate-capsules', baseRevision: outputs[0].revision,
                operations: [
                    { op: 'node.update', nodeId: 'first', patch: { referenceAnnotation: '人物外观' } },
                    { op: 'node.update', nodeId: 'second', patch: { referenceAnnotation: '办公室背景' } },
                    { op: 'node.set-prompt', nodeId: 'generate', promptParts: [
                        { sourceNodeId: 'first' }, { text: '走入' }, { sourceNodeId: 'second' },
                        { text: '，保持' }, { sourceNodeId: 'first' }, { text: '服装与外观一致。' }
                    ] }
                ] })
        ] };
        else if (!outputs.some(result => result.total !== undefined)) message = { role: 'assistant', content: '', tool_calls: [
            tool('find', 'flow_canvas.asset.search', { query: '人物外观' })
        ] };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await fs.mkdir(path.join(profile, 'data'), { recursive: true });
        const paths = ['first', 'second'].map(name => path.join(directory, `${name}.png`));
        for (const [index, file] of paths.entries()) await sharp({ create: {
            width: 240, height: 160, channels: 3, background: index ? '#8196ae' : '#ac8c91'
        } }).png().toFile(file);
        const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
        await fs.writeFile(path.join(profile, 'fixture-api.json'), JSON.stringify({ version: 1, providers: [
            { id: 'text', name: 'Mock text', capability: 'text', type: 'openai', endpoint, model: 'mock-text', apiKey: 'fixture-only' }
        ], globalConfig: { textProviderId: 'text', agentExecutionMode: 'auto' } }));
        const items = paths.map((filePath, index) => ({ id: index ? 'second' : 'first', kind: 'media', mediaType: 'image', filePath,
            referenceAnnotation: '',
            x: 80, y: 80 + index * 220, width: 240, height: 160 }));
        items.push({ id: 'generate', kind: 'op', nodeType: 'video', title: '素材引用', x: 450, y: 200, width: 320, height: 180,
            config: { prompt: '原提示词', ratio: '16:9', duration: 5, count: 1 } });
        const connections = ['second', 'first'].map(id => ({ id: `${id}-target`,
            from: { nodeId: id, port: 'image' }, to: { nodeId: 'generate', port: 'source' } }));
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'citations',
            items, connections, viewport: { x: 0, y: 0, scale: 1 }, mcp: { enabled: false },
            folderGroups: [{ id: 'citations', name: 'Agent 素材引用', folders: [directory], defaultSaveFolder: directory,
                savedItems: items, connections, boardRevision: 0 }] }));
        const env = { ...process.env, FLOW_CANVAS_SMOKE_PROFILE: profile, FLOW_CANVAS_SMOKE_LIVE: '0' };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('scripts/agent-smoke-entry.cjs')], env });
        let page;
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /index\.html|127\.0\.0\.1:15321/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await page.waitForFunction(() => window.flowCanvas?.agent && window.Konva?.stages[0]?.findOne('#generate'));
        await page.evaluate(async filePath => window.flowCanvas.asset.updateMetadata(filePath, { referenceAnnotation: '过期标注' }), paths[0]);
        await page.reload();
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#generate'));
        await page.evaluate(() => window.Konva.stages[0].findOne('#generate').fire('click', { evt: { button: 0 } }));
        assert.deepEqual(await page.locator('.generation-composer-reference-annotation input').evaluateAll(inputs => inputs.map(input => input.value)), ['', '']);
        const run = await page.evaluate(() => window.flowCanvas.agent.start({ projectId: 'citations', conversationId: 'test',
            providerId: 'text', mode: 'auto', messages: [{ role: 'user', content: '标注素材并使用胶囊引用，不生成。' }] }));
        let result;
        for (let attempt = 0; attempt < 200; attempt++) {
            result = await page.evaluate(id => window.flowCanvas.agent.get({ runId: id }), run.id);
            if (['completed', 'failed'].includes(result.status)) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(result.status, 'completed', result.error);
        assert.deepEqual(failures, []);
        const search = result.events.find(event => event.type === 'tool_result' && event.data.tool === 'flow_canvas.asset.search');
        assert.equal(search.data.result.items[0].referenceAnnotation, '人物外观');
        await page.evaluate(() => window.Konva.stages[0].findOne('#generate').fire('click', { evt: { button: 0 } }));
        const pills = page.locator('.generation-composer-citation');
        await page.waitForFunction(() => document.querySelectorAll('.generation-composer-citation').length === 3);
        assert.deepEqual(await pills.allTextContents(), ['人物外观 · 图二', '办公室背景 · 图一', '人物外观 · 图二']);
        assert.deepEqual(await page.locator('.generation-composer-reference-annotation input').evaluateAll(inputs => inputs.map(input => input.value)),
            ['办公室背景', '人物外观']);
        await page.waitForFunction(() => [...document.querySelectorAll('.generation-composer-reference-preview img')]
            .every(image => image.complete && image.naturalWidth > 0));
        await fs.mkdir('output/playwright', { recursive: true });
        await page.screenshot({ path: 'output/playwright/agent-material-citations.png' });
        await page.reload();
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#generate'));
        await page.evaluate(() => window.Konva.stages[0].findOne('#generate').fire('click', { evt: { button: 0 } }));
        await page.waitForFunction(() => document.querySelectorAll('.generation-composer-citation').length === 3);
        assert.deepEqual(await pills.allTextContents(), ['人物外观 · 图二', '办公室背景 · 图一', '人物外观 · 图二']);
        console.log('PASS Agent material annotations and real capsules through tool schema, runtime transaction, renderer and reload; no generation submitted.');
    } finally {
        await app?.close();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
