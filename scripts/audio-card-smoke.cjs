const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function wav() {
    const rate = 16000, samples = rate * 12;
    const data = Buffer.alloc(44 + samples * 2);
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
    data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
    data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
    data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / rate) * 1000), 44 + i * 2);
    return data;
}

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-audio-card-'));
    let app;
    try {
        const mediaRoot = path.join(profile, 'data', 'captured');
        await fs.mkdir(mediaRoot, { recursive: true });
        const filePath = path.join(mediaRoot, 'Audio playback fixture.wav');
        await fs.writeFile(filePath, wav());
        const items = [{ id: 'audio-fixture', kind: 'media', mediaType: 'audio', filePath,
            x: 120, y: 140, width: 300, height: 96 }];
        await fs.writeFile(path.join(profile, 'data', 'board.json'), JSON.stringify({
            version: 1, activeGroupId: 'audio-smoke', items, connections: [],
            folderGroups: [{ id: 'audio-smoke', name: 'Audio playback', savedItems: items,
                connections: [], folders: [mediaRoot], boardRevision: 0 }],
            sidebarClosed: true, resourceSaver: true, mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 }
        }));
        const env = { ...process.env, FLOW_MEDIA_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: [path.join(__dirname, 'media-preview-smoke-entry.cjs'), '--mute-audio'], env });
        let page;
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'Main renderer created');
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#audio-fixture')?.findOne('.audioControls'), null, { timeout: 15000 });
        const point = (selector, ratio = 0.5) => page.evaluate(({ selector, ratio }) => {
            const stage = window.Konva.stages[0];
            const node = stage.findOne('#audio-fixture').findOne(selector);
            const position = node.getAbsoluteTransform().point({ x: node.width() * ratio, y: node.height() / 2 });
            const bounds = stage.container().getBoundingClientRect();
            return { x: bounds.left + position.x, y: bounds.top + position.y };
        }, { selector, ratio });
        const click = async selector => { const p = await point(selector); await page.mouse.click(p.x, p.y); };
        await click('.audioFileName');
        assert.equal(await page.locator('.canvas-media-preview').count(), 0, 'Selecting the card must not enlarge it');
        assert.equal(await page.locator('audio[data-canvas-audio-id]').count(), 0, 'No audio decoding before playback');
        await click('.videoPlayPauseHotspot');
        await page.waitForFunction(() => {
            const audio = document.querySelector('audio[data-canvas-audio-id]');
            return audio && !audio.paused && audio.currentTime > 0.2;
        });
        await page.mouse.move(700, 400);
        await page.waitForTimeout(500);
        assert.equal(await page.locator('audio[data-canvas-audio-id]').evaluate(audio => audio.paused), false, 'Hover transitions must not stop playback');
        await click('.videoPlayPauseHotspot');
        assert.equal(await page.locator('audio[data-canvas-audio-id]').evaluate(audio => audio.paused), true);
        const from = await point('.videoProgressHotspot', 0.2), to = await point('.videoProgressHotspot', 0.75);
        await page.mouse.move(from.x, from.y); await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up();
        const position = await page.locator('audio[data-canvas-audio-id]').evaluate(audio => audio.currentTime / audio.duration);
        assert.ok(Math.abs(position - 0.75) < 0.04, `Seek ratio: ${position}`);
        await click('.videoVolumeHotspot');
        assert.equal(await page.locator('audio[data-canvas-audio-id]').evaluate(audio => audio.muted), true);
        assert.equal(await page.locator('.canvas-media-preview').count(), 0);
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'audio-card-inline.png') });
        await page.evaluate(() => {
            const stage = window.Konva.stages[0]; stage.scale({ x: 0.5, y: 0.5 }); stage.batchDraw();
        });
        await page.waitForTimeout(250);
        await click('.videoPlayPauseHotspot');
        await page.waitForFunction(() => !document.querySelector('audio[data-canvas-audio-id]').paused);
        await page.screenshot({ path: path.join(output, 'audio-card-zoomed-out.png') });
        await click('.audioFileName');
        await page.keyboard.press('Delete');
        await page.waitForFunction(() => !window.Konva.stages[0].findOne('#audio-fixture'));
        assert.equal(await page.locator('audio[data-canvas-audio-id]').count(), 0, 'Removing a card releases audio');
        console.log('Audio card smoke passed: inline play/pause, seek dragging, mute, zoom, hover, selection, no preview modal, and deletion cleanup.');
    } finally {
        await app?.close();
        const relative = path.relative(os.tmpdir(), profile);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
