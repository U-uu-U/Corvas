const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function waitForBoard(boardPath, predicate) {
    const deadline = Date.now() + 15000;
    let board;
    while (Date.now() < deadline) {
        board = JSON.parse(await fs.readFile(boardPath, 'utf8'));
        if (predicate(board)) return board;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Board save did not settle: ${board?.items?.length} items, ${board?.connections?.length} connections`);
}

function assertInputs(board, targetId) {
    const inputs = board.connections.filter(connection => connection.to.nodeId === targetId);
    assert.deepEqual(inputs.map(connection => connection.from.nodeId), ['reference-a', 'reference-b']);
    assert.ok(inputs.every(connection => connection.from.port === 'out' && connection.to.port === 'source'));
}

(async () => {
    const root = path.resolve(__dirname, '..');
    const built = await fs.stat(path.join(root, 'dist/index.html'));
    const edited = await fs.stat(path.join(root, 'src/canvas.js'));
    assert.ok(built.mtimeMs >= edited.mtimeMs, 'Run npm run build after editing src/canvas.js');
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-duplicate-node-'));
    const boardPath = path.join(profile, 'data/board.json');
    let app;
    let page;
    const errors = [];
    try {
        const resultPath = path.join(profile, 'result.png');
        await fs.writeFile(resultPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'));
        const items = [
            { id: 'reference-a', kind: 'media', mediaType: 'image', title: 'Reference A', x: 110, y: 140, width: 180, height: 135 },
            { id: 'reference-b', kind: 'media', mediaType: 'image', title: 'Reference B', x: 110, y: 380, width: 180, height: 135 },
            { id: 'duplicate-target', kind: 'op', nodeType: 'image', title: 'Original result', x: 520, y: 120,
                width: 264, height: 150, config: { prompt: 'Duplicate connection fixture', ratio: '16:9' },
                resultEntries: [{ filePath: resultPath }], preserveGeneratorStack: true, runStatus: 'idle' }
        ];
        const connections = ['a', 'b'].map(key => ({ id: `original-${key}`,
            from: { nodeId: `reference-${key}`, port: 'out' }, to: { nodeId: 'duplicate-target', port: 'source' } }));
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(boardPath, JSON.stringify({ version: 1, activeGroupId: 'duplicate-smoke', items, connections,
            folderGroups: [{ id: 'duplicate-smoke', name: 'Duplicate verification', savedItems: items, connections, folders: [], boardRevision: 0 }],
            sidebarClosed: true, mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
        const env = { ...process.env, FLOW_MEDIA_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: [path.join(__dirname, 'media-preview-smoke-entry.cjs')], env });
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'The isolated canvas opens');
        page.on('pageerror', error => errors.push(error.message));
        await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows().find(entry => /index\.html/.test(entry.webContents.getURL()));
            window.setContentSize(1280, 900);
        });
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#original-b')?.isVisible());
        await page.evaluate(() => window.Konva.stages[0].findOne('#duplicate-target')
            .fire('click', { evt: { button: 0, shiftKey: true } }));
        await page.locator('.canvas-selection-toolbar [data-action="duplicate"]').click();
        const toolbarBoard = await waitForBoard(boardPath, board => board.items.length === 4 && board.connections.length === 4);
        const toolbarCopy = toolbarBoard.items.find(item => !items.some(original => original.id === item.id));
        assert.ok(toolbarCopy);
        assertInputs(toolbarBoard, toolbarCopy.id);
        assertInputs(toolbarBoard, 'duplicate-target');
        await page.evaluate(nodeId => {
            const node = window.Konva.stages[0].findOne(`#${nodeId}`);
            node.position({ x: 840, y: 290 });
            node.fire('dragend', { evt: {} });
        }, toolbarCopy.id);
        await page.evaluate(() => window.Konva.stages[0].findOne('#duplicate-target')
            .fire('contextmenu', { evt: { button: 2, clientX: 680, clientY: 170, preventDefault() {} } }));
        await page.locator('#contextMenu [data-action="duplicateNode"]').click();
        const contextBoard = await waitForBoard(boardPath, board => board.items.length === 5 && board.connections.length === 6);
        const contextCopy = contextBoard.items.find(item => !toolbarBoard.items.some(original => original.id === item.id));
        assert.ok(contextCopy);
        for (const id of ['duplicate-target', toolbarCopy.id, contextCopy.id]) assertInputs(contextBoard, id);
        assert.equal(new Set(contextBoard.connections.map(connection => connection.id)).size, 6);
        assert.deepEqual(contextBoard.connections.filter(connection => connection.id.startsWith('original-')), connections);
        await page.evaluate(nodeId => {
            const node = window.Konva.stages[0].findOne(`#${nodeId}`);
            node.position({ x: 520, y: 560 });
            node.fire('dragend', { evt: {} });
        }, contextCopy.id);
        const savedBoard = await waitForBoard(boardPath, board => board.items.find(item => item.id === contextCopy.id)?.y === 560);
        assert.equal(savedBoard.folderGroups[0].connections.length, 6);
        await page.reload();
        await page.waitForFunction(ids => {
            const stage = window.Konva?.stages[0];
            return stage && ids.every(id => stage.findOne(`#${id}`)?.isVisible());
        }, savedBoard.connections.map(connection => connection.id));
        const reloaded = JSON.parse(await fs.readFile(boardPath, 'utf8'));
        for (const id of ['duplicate-target', toolbarCopy.id, contextCopy.id]) assertInputs(reloaded, id);
        assert.equal(await page.evaluate(() => window.Konva.stages[0].find('.graphEdge').length), 6);
        assert.ok(await page.evaluate(() => {
            const canvas = window.Konva.stages[0].findOne('#original-a').getLayer().getCanvas()._canvas;
            return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
                .some((value, index) => index % 4 === 3 && value > 0);
        }), 'The connection layer has rendered pixels');
        assert.deepEqual(errors, []);
        const artifacts = path.join(root, 'output/playwright');
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, 'duplicate-node-connections.png') });
        console.log('PASS duplicate nodes: toolbar and context menu retain ordered reference inputs, originals unchanged, new edge IDs, save/reload preserves six visible connections. No generation requests.');
    } catch (error) {
        if (page) {
            console.error('Renderer errors:', errors);
            console.error('Canvas state:', await page.evaluate(() => ({
                stages: window.Konva?.stages?.length,
                nodes: window.Konva?.stages[0]?.find('.nodeGroup').map(node => node.id()),
                edges: window.Konva?.stages[0]?.find('.graphEdge').map(edge => ({ id: edge.id(), visible: edge.isVisible() }))
            })).catch(() => null));
        }
        throw error;
    } finally {
        await app?.close();
        const relative = path.relative(os.tmpdir(), profile);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
