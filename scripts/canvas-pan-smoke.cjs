const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const root = path.resolve(__dirname, '..');
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-pan-'));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        const filePath = path.join(profile, 'reference.jpg');
        await sharp(path.join(root, 'electron-main/assets/app-icon.png')).resize(1280, 768, { fit: 'fill' }).jpeg().toFile(filePath);
        const items = Array.from({ length: 180 }, (_, i) => ({
            id: `pan-${i}`, kind: 'media', mediaType: 'image', filePath,
            x: 120 + (i % 15) * 250, y: 140 + Math.floor(i / 15) * 180, width: 220, height: 132
        }));
        const connections = items.slice(1).map((item, i) => ({ id: `edge-${i}`, from: { nodeId: items[i].id, port: 'out' }, to: { nodeId: item.id, port: 'source' } }));
        const viewport = { x: 0, y: 0, scale: 0.6 };
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'pan', items, connections, viewport, autoSnapEnabled: false,
            folderGroups: [{ id: 'pan', name: 'Pan performance', folders: [], savedItems: items, connections, viewport }], mcp: { enabled: false } }));
        await fs.writeFile(path.join(profile, 'fixture-api.json'), JSON.stringify({ providers: [], globalConfig: {} }));
        const env = { ...process.env, FLOW_CANVAS_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.FLOW_CANVAS_SMOKE_LIVE;
        delete env.FLOW_CANVAS_SMOKE_ASAR;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'agent-smoke-entry.cjs')], env });
        let page;
        for (let i = 0; i < 200; i++) {
            page = app.windows().find(window => window.url().startsWith('http://127.0.0.1:15321'));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'Vite must be running on port 15321');
        await (await app.browserWindow(page)).evaluate(window => window.setSize(1400, 900));
        await page.waitForFunction(() => window.Konva?.stages[0]?.find('.nodeGroup').length === 180);
        await page.evaluate(async () => {
            const moduleUrl = name => performance.getEntriesByType('resource').map(entry => entry.name)
                .find(url => new URL(url).pathname === `/${name}.js`);
            const { CanvasManager } = await import(moduleUrl('canvas'));
            const { GraphView } = await import(moduleUrl('graph-view'));
            window.__panStats = {};
            for (const name of ['drawScene', 'drawHit']) {
                const original = window.Konva.Layer.prototype[name];
                window.Konva.Layer.prototype[name] = function (...args) {
                    const start = performance.now();
                    try { return original.apply(this, args); }
                    finally {
                        const stat = window.__panStats[`layer-${name}`] ||= { calls: 0, ms: 0 };
                        stat.calls++; stat.ms += performance.now() - start;
                    }
                };
            }
            for (const [prototype, names] of [[CanvasManager.prototype, ['syncPlanInlineEditors', '_syncViewportFixedControls', '_syncHoveredMediaItemAtPointer', '_drainContentLoadQueue']], [GraphView.prototype, ['sync']]]) {
                for (const name of names) {
                    const original = prototype[name];
                    prototype[name] = function (...args) {
                        if (prototype === CanvasManager.prototype) window.__panCanvas = this;
                        const start = performance.now();
                        try { return original.apply(this, args); }
                        finally {
                            const stat = window.__panStats[name] ||= { calls: 0, ms: 0 };
                            stat.calls++; stat.ms += performance.now() - start;
                        }
                    };
                }
            }
            window.Konva.stages[0].x(1);
        });
        await page.waitForFunction(() => window.__panCanvas?.getResourceUsageStats().loaded === 180);
        await page.waitForTimeout(400);
        const cdp = process.env.FLOW_PAN_PROFILE ? await page.context().newCDPSession(page) : null;
        if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
        const start = await page.evaluate(() => {
            window.__panStats = {};
            window.__panFrames = [];
            window.__panMeasure = true;
            let last = performance.now();
            const frame = now => { window.__panFrames.push(now - last); last = now; if (window.__panMeasure) requestAnimationFrame(frame); };
            requestAnimationFrame(frame);
            const stage = window.Konva.stages[0];
            const rect = stage.container().getBoundingClientRect();
            return { x: rect.left + 80, y: rect.top + 65, position: stage.position() };
        });
        await page.mouse.move(start.x, start.y);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(start.x + 440, start.y + 80, { steps: 100 });
        await page.mouse.up({ button: 'right' });
        await page.waitForTimeout(350);
        const result = await page.evaluate(() => {
            window.__panMeasure = false;
            const samples = window.__panFrames.slice(2).sort((a, b) => a - b);
            return { position: window.Konva.stages[0].position(), frames: samples.length,
                medianMs: samples[Math.floor(samples.length * 0.5)], p95Ms: samples[Math.floor(samples.length * 0.95)],
                stats: window.__panStats, connections: window.__panCanvas.graphView.connections.length };
        });
        if (cdp) {
            const { profile: cpu } = await cdp.send('Profiler.stop');
            const byId = new Map(cpu.nodes.map(node => [node.id, node.callFrame]));
            const totals = new Map();
            cpu.samples.forEach((id, i) => {
                const frame = byId.get(id);
                const name = `${frame.functionName} ${frame.url}:${frame.lineNumber}`;
                totals.set(name, (totals.get(name) || 0) + cpu.timeDeltas[i] / 1000);
            });
            result.cpu = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 15);
        }
        assert.ok(Math.abs(result.position.x - start.position.x - 440) < 2, 'Pan follows the pointer');
        assert.ok(Math.abs(result.position.y - start.position.y - 80) < 2, 'Pan has no drift');
        assert.equal(result.connections, 179);
        const output = path.join(root, 'output/playwright');
        await fs.mkdir(output, { recursive: true });
        const label = process.env.FLOW_PAN_LABEL || 'current';
        assert.match(label, /^[a-z0-9-]+$/);
        await page.screenshot({ path: path.join(output, `canvas-pan-${label}.png`) });
        const nodePoint = () => page.evaluate(() => {
            const canvas = window.__panCanvas;
            const group = canvas.items.get('pan-0').group;
            const rect = canvas.stage.container().getBoundingClientRect();
            const point = group.getAbsoluteTransform().point({ x: 80, y: 65 });
            return { x: rect.left + point.x, y: rect.top + point.y,
                viewport: canvas.stage.position(), node: group.position() };
        });
        const beforeMiddle = await nodePoint();
        await page.mouse.move(beforeMiddle.x, beforeMiddle.y);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(beforeMiddle.x + 60, beforeMiddle.y + 30, { steps: 8 });
        await page.mouse.up({ button: 'middle' });
        const afterMiddle = await nodePoint();
        assert.deepEqual(afterMiddle.node, beforeMiddle.node, 'Middle drag moves the canvas, not its media');
        assert.ok(Math.abs(afterMiddle.viewport.x - beforeMiddle.viewport.x - 60) < 2);
        await page.mouse.move(afterMiddle.x, afterMiddle.y);
        await page.mouse.down();
        await page.mouse.move(afterMiddle.x + 40, afterMiddle.y + 20, { steps: 8 });
        await page.mouse.up();
        const afterNodeDrag = await nodePoint();
        assert.ok(afterNodeDrag.node.x > afterMiddle.node.x + 30, 'Nodes remain draggable after canvas panning');
        const state = await page.evaluate(() => ({
            selected: [...window.__panCanvas.selectedItems],
            connections: window.__panCanvas.graphView.connections.length,
            shadows: window.Konva.stages[0].find('Image').filter(image => image.hasShadow()).length,
            loaded: window.__panCanvas.getResourceUsageStats().loaded
        }));
        assert.ok(state.selected.includes('pan-0'));
        assert.equal(state.connections, 179);
        assert.equal(state.shadows, 0);
        assert.equal(state.loaded, 180);
        await page.mouse.wheel(0, -80);
        await page.waitForFunction(() => window.__panStats._syncViewportFixedControls?.calls > 0);
        result.interactions = 'right pan, middle pan over media, node drag after pan, selection, zoom, no media shadows, retained media and connections';
        await fs.writeFile(path.join(output, `canvas-pan-${label}.json`), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } finally {
        await app?.close();
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('corvas-pan-'));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
