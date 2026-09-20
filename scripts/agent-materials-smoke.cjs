const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-agent-materials-'));
    const screenshots = path.resolve(__dirname, '../output/playwright');
    const requests = [];
    const provider = http.createServer(async (request, response) => {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Reference materials received.' }, finish_reason: 'stop' }] }));
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    let app, page;
    const readBoard = async () => JSON.parse(await fs.readFile(path.join(profile, 'data/board.json'), 'utf8'));
    const pollBoard = async predicate => {
        for (let attempt = 0; attempt < 150; attempt++) {
            const board = await readBoard(); if (predicate(board)) return board;
            await new Promise(resolve => setTimeout(resolve, 70));
        }
        throw new Error('Board did not reach the expected state');
    };
    const point = id => page.evaluate(id => {
        const stage = window.Konva.stages[0];
        const group = stage.findOne('#' + id);
        const rect = (group.findOne('.displayNode') || group.findOne('.fallbackBg')).getClientRect();
        const container = stage.container().getBoundingClientRect();
        return { x: container.left + rect.x + rect.width / 2, y: container.top + rect.y + rect.height / 2 };
    }, id);
    const click = async id => { const p = await point(id); await page.mouse.click(p.x, p.y); };
    try {
        await fs.mkdir(path.join(profile, 'data')); await fs.mkdir(screenshots, { recursive: true });
        const mediaDirectory = path.join(profile, 'data', 'captured');
        await fs.mkdir(mediaDirectory);
        const firstPath = path.join(mediaDirectory, 'original.png'), secondPath = path.join(mediaDirectory, 'second.png');
        for (const [index, file] of [firstPath, secondPath].entries()) await sharp({ create: { width: 160, height: 200, channels: 3,
            background: index ? '#998772' : '#6d8a85' } }).png().toFile(file);
        const videoPath = path.join(mediaDirectory, 'motion.mp4'), audioPath = path.join(mediaDirectory, 'voice.wav');
        execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath]);
        execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '1', audioPath]);
        const items = [
            { id: 'original', kind: 'media', mediaType: 'image', filePath: firstPath, x: 90, y: 70, width: 160, height: 200, referenceAnnotation: '产品' },
            { id: 'second', kind: 'media', mediaType: 'image', filePath: secondPath, x: 320, y: 350, width: 160, height: 200 },
            { id: 'video', kind: 'media', mediaType: 'video', filePath: videoPath, x: 90, y: 350, width: 160, height: 90 },
            { id: 'audio', kind: 'media', mediaType: 'audio', filePath: audioPath, x: 90, y: 550, width: 300, height: 96 }
        ];
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items, connections: [], activeGroupId: 'materials',
            folderGroups: [{ id: 'materials', name: 'Agent materials', folders: [], savedItems: items, connections: [], boardRevision: 0,
                viewport: { x: 0, y: 0, scale: 1 } }], viewport: { x: 0, y: 0, scale: 1 }, mcp: { enabled: false } }));
        const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
        await fs.writeFile(path.join(profile, 'fixture-api.json'), JSON.stringify({ version: 1, revision: 1, providers: [
            { id: 'image', name: 'Fixture image', capability: 'image', endpoint, type: 'openai', apiKey: 'fixture', model: 'gpt-image-2' },
            { id: 'text', name: 'Fixture text', capability: 'text', endpoint, type: 'openai', apiKey: 'fixture', model: 'fixture-text' }
        ], globalConfig: { imageProviderId: 'image', textProviderId: 'text', imageIntentPipelineMode: 'off', imageIntentPipelineVersion: 2 } }));
        const env = { ...process.env, FLOW_CANVAS_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        // Use the existing isolated API setup, with the bundled renderer rather than a user's dev server.
        env.FLOW_CANVAS_SMOKE_ASAR = path.resolve(__dirname, '..');
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'agent-smoke-entry.cjs')], env });
        for (let i = 0; i < 150; i++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break; await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#original')?.findOne('.displayNode'));
        const originalBefore = (await readBoard()).items.find(item => item.id === 'original');
        const start = await point('original');
        await page.mouse.move(start.x, start.y); await page.keyboard.down('Control'); await page.mouse.down();
        await page.mouse.move(start.x + 220, start.y + 20, { steps: 25 }); await page.mouse.up(); await page.keyboard.up('Control');
        let board = await pollBoard(board => board.items.length === 5);
        const copy = board.items.find(item => !items.some(original => original.id === item.id));
        assert.ok(copy && copy.id !== 'original');
        assert.equal(board.items.find(item => item.id === 'original').x, originalBefore.x, 'Ctrl-drag must leave the original identity in place');
        assert.ok(copy.x > originalBefore.x + 150, 'The fresh copy follows the pointer');
        assert.equal(copy.referenceAnnotation, '产品');
        await page.evaluate(id => document.dispatchEvent(new CustomEvent('context-remove', { detail: { itemIds: [id] } })), copy.id);
        board = await pollBoard(board => !board.items.some(item => item.id === copy.id));
        assert.equal(board.items.find(item => item.id === 'original').filePath, firstPath);
        await fs.access(firstPath);
        await click('original');
        const composer = page.locator('.generation-composer');
        await composer.waitFor();
        await composer.locator('[data-prompt]').fill('保留产品外形');
        await composer.locator('[data-agent-mode]').click();
        await page.waitForFunction(() => document.body.classList.contains('agent-open'));
        board = await pollBoard(board => board.items.some(item => item.kind === 'op' && item.nodeType === 'image'));
        const target = board.items.find(item => item.kind === 'op' && item.nodeType === 'image');
        assert.equal(target.composerDraft, undefined);
        await page.locator('#agentInput').click();
        await page.waitForSelector('.generation-composer', { state: 'detached' });
        await page.locator('#agentAddMaterialBtn').click();
        await click('second');
        await page.waitForFunction(() => document.querySelectorAll('#agentAttachmentList .agent-attachment-item').length === 2);
        await page.locator('#agentAddMaterialBtn').click();
        await page.locator('#agentInput').fill('检查这两张参考图。');
        await page.locator('#agentSendBtn').click();
        await page.waitForFunction(() => document.querySelector('#agentMessages').textContent.includes('Reference materials received.'));
        board = await pollBoard(board => board.connections.some(edge => edge.from.nodeId === 'second' && edge.to.nodeId === target.id));
        assert.ok(board.items.some(item => item.id === target.id));
        assert.equal((await page.locator('#agentMessages').innerText()).includes('节点已不存在'), false);
        assert.ok(JSON.stringify(requests[0]).includes(target.id));
        assert.ok(JSON.stringify(requests[0]).includes('second'));
        await page.locator('#agentAddMaterialBtn').click();
        for (const id of ['original', 'second', 'video', 'audio']) await click(id);
        await page.waitForFunction(() => document.querySelectorAll('#agentAttachmentList .agent-attachment-item').length === 4);
        assert.match(await page.locator('#agentContextSummary').innerText(), /图片2.*视频1.*音频1/);
        const wheel = await point('original'); await page.mouse.move(wheel.x, wheel.y); await page.mouse.wheel(0, 100);
        assert.equal(await page.locator('#agentAttachmentList .agent-attachment-item').count(), 4);
        await page.locator('#agentAttachmentList [data-remove-agent-attachment="1"]').click();
        assert.equal(await page.locator('#agentAttachmentList .agent-attachment-item').count(), 3);
        await click('second');
        await page.waitForFunction(() => document.querySelectorAll('#agentAttachmentList .agent-attachment-item').length === 4);
        await page.locator('#agentInput').focus(); await page.keyboard.press('Escape');
        assert.equal(await page.locator('#agentAddMaterialBtn').getAttribute('aria-pressed'), 'false');
        for (const theme of ['dark', 'light']) {
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            await page.screenshot({ path: path.join(screenshots, `agent-materials-${theme}.png`) });
        }
        await page.reload();
        await page.waitForSelector('#agentAddMaterialBtn', { state: 'attached' });
        await page.locator('#agentToggleBtn').click();
        await page.waitForFunction(() => document.querySelectorAll('#agentAttachmentList .agent-attachment-item').length === 4);
        await page.locator('#agentInput').fill('描述所选素材'); await page.locator('#agentSendBtn').click();
        await page.waitForFunction(() => document.querySelectorAll('#agentAttachmentList .agent-attachment-item').length === 0);
        assert.equal(requests.length, 2);
        console.log('Agent materials smoke passed: real Ctrl-drag copy/delete, persistent Agent source, manual reference wiring, mixed media selection/remove/re-add, wheel isolation, reload and send.');
    } catch (error) {
        await page?.screenshot({ path: path.join(screenshots, 'agent-materials-failure.png') }).catch(() => {});
        throw error;
    } finally {
        await app?.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
