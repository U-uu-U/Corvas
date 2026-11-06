const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-graph-visibility-'));
    // The canvas only keeps media items backed by real image/video/audio files; keep them outside userData.
    const media = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-graph-visibility-media-'));
    let app;
    try {
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
        const items = [];
        for (let index = 0; index < 262; index++) {
            const filePath = path.join(media, `filler-${index}.png`);
            await fs.writeFile(filePath, png);
            items.push({ id: `filler-${index}`, kind: 'media', mediaType: 'image', filePath,
                x: -10000 - index * 150, y: -10000, width: 100, height: 100 });
        }
        const samples = 8000;
        const wav = Buffer.alloc(44 + samples * 2);
        wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8);
        wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
        wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
        for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / 8000)), 44 + i * 2);
        const audioPath = path.join(media, 'late-source.wav');
        await fs.writeFile(audioPath, wav);
        items.push({ id: 'late-source', kind: 'media', mediaType: 'audio', filePath: audioPath, x: 150, y: 220, width: 300, height: 96 },
            { id: 'late-target', kind: 'op', nodeType: 'video', x: 650, y: 160, width: 300, height: 170, config: {}, runStatus: 'running' });
        const connections = [{ id: 'late-edge', from: { nodeId: 'late-source', port: 'out' }, to: { nodeId: 'late-target', port: 'source' } }];
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(path.join(profile, 'data', 'board.json'), JSON.stringify({
            version: 1, activeGroupId: 'graph-smoke', items, connections,
            folderGroups: [{ id: 'graph-smoke', name: 'Connection visibility', savedItems: items, connections, folders: [], boardRevision: 0 }],
            sidebarClosed: true, resourceSaver: true, mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 }
        }));
        const env = { ...process.env, FLOW_MEDIA_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'media-preview-smoke-entry.cjs')], env });
        let page;
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        await page.waitForFunction(() => {
            const edge = window.Konva?.stages[0]?.findOne('#late-edge');
            return edge?.isVisible() && edge.points().every(Number.isFinite);
        }, null, { timeout: 15000 });
        await page.waitForTimeout(400);
        const onboarding = page.locator('#siteLoginDialog[open]');
        if (await onboarding.count()) await onboarding.locator('[data-login-skip]').click();
        const shapeCount = () => page.evaluate(() => window.Konva.stages[0].find('.graphEdge').length);
        assert.equal(await shapeCount(), 1, 'The saved edge renders after the third node batch');
        await page.locator('#canvasConnectionsToggle').click();
        assert.equal(await page.evaluate(() => window.Konva.stages[0].findOne('#late-edge').isVisible()), false);
        const points = await page.evaluate(() => {
            const stage = window.Konva.stages[0], bounds = stage.container().getBoundingClientRect();
            const line = stage.findOne('#late-edge'), coordinates = line.points();
            return [0, 6].map(index => {
                const p = stage.getAbsoluteTransform().point({ x: coordinates[index], y: coordinates[index + 1] });
                return { x: bounds.left + p.x, y: bounds.top + p.y };
            });
        });
        await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
        await page.mouse.move(points[1].x, points[1].y, { steps: 8 }); await page.mouse.up();
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#late-edge')?.isVisible());
        assert.equal(await shapeCount(), 1, 'Dragging an existing connection does not duplicate it');
        assert.equal(await page.locator('#canvasConnectionsToggle').getAttribute('aria-pressed'), 'true');
        const nonblank = await page.evaluate(() => {
            const edge = window.Konva.stages[0].findOne('#late-edge');
            const canvas = edge.getLayer().getCanvas()._canvas;
            return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
        });
        assert.ok(nonblank, 'The edge layer contains rendered pixels');
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'graph-visibility-recovered.png') });
        console.log('Connection visibility smoke passed: 264 nodes, third-batch endpoints, visible saved edge, duplicate drag reveals hidden edge, synchronized toggle, and nonblank edge pixels.');
    } finally {
        await app?.close();
        const relative = path.relative(os.tmpdir(), profile);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await fs.rm(media, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
