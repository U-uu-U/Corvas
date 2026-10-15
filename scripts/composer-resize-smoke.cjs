const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const root = path.resolve(__dirname, '..');
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-composer-resize-'));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(path.join(profile, 'data/relay-browser.json'), JSON.stringify({ onboardingSkipped: true }));
        const items = [{ id: 'generate', kind: 'op', nodeType: 'image', x: 200, y: 80, width: 200, height: 160,
            config: { prompt: 'Keep the product shape and surface details.', providerId: 'fixture', model: 'gpt-image-2' } }];
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ items, connections: [], activeGroupId: 'resize',
            folderGroups: [{ id: 'resize', name: 'Resize', folders: [], savedItems: items, connections: [], viewport: { x: 0, y: 0, scale: 1 } }],
            viewport: { x: 0, y: 0, scale: 1 }, mcp: { enabled: false } }));
        await fs.writeFile(path.join(profile, 'fixture-api.json'), JSON.stringify({ version: 1, revision: 1,
            providers: [{ id: 'fixture', name: 'Fixture image', capability: 'image', endpoint: 'http://127.0.0.1:9/v1',
                type: 'openai', apiKey: 'fixture', model: 'gpt-image-2' }], globalConfig: { imageProviderId: 'fixture', imageIntentPipelineMode: 'off' } }));
        const env = { ...process.env, FLOW_CANVAS_SMOKE_PROFILE: profile, FLOW_CANVAS_SMOKE_ASAR: root };
        delete env.ELECTRON_RUN_AS_NODE;
        const launch = () => electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'agent-smoke-entry.cjs')], env });
        app = await launch();
        const mainPage = async () => {
            for (let i = 0; i < 120; i++) {
                const page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
                if (page) {
                    await page.waitForFunction(() => document.visibilityState === 'visible' && window.Konva?.stages[0]?.findOne('#generate'));
                    const notice = page.locator('#mcpStartupNotice [data-action=close]');
                    if (await notice.isVisible()) await notice.click();
                    return page;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('Main window missing');
        };
        let page = await mainPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const open = async () => {
            await page.evaluate(() => document.dispatchEvent(new CustomEvent('context-edit-node', { detail: { nodeId: 'generate' } })));
            await page.locator('.generation-composer-resize').waitFor();
            await page.waitForFunction(() => document.querySelector('.generation-composer')?.getAnimations().every(animation => animation.playState === 'finished'));
        };
        const bounds = () => page.evaluate(() => {
            const panel = document.querySelector('.generation-composer');
            const r = panel.getBoundingClientRect(), p = panel.querySelector('.generation-composer-prompt-shell').getBoundingClientRect();
            const submit = panel.querySelector('[data-submit]').getBoundingClientRect();
            const handle = document.querySelector('.generation-composer-resize').getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
                promptHeight: p.height, submitRight: submit.right, submitBottom: submit.bottom,
                handleX: handle.x, handleY: handle.y, handleRight: handle.right, handleBottom: handle.bottom,
                outerHandle: !panel.contains(document.querySelector('.generation-composer-resize')),
                overflow: panel.scrollWidth > panel.clientWidth + 1 };
        });
        const drag = async (dx, dy) => {
            const r = await page.locator('.generation-composer-resize').boundingBox();
            const x = r.x + r.width / 2, y = r.y + r.height / 2;
            await page.mouse.move(x, y); await page.mouse.down();
            await page.mouse.move(x + dx, y + dy, { steps: 20 }); await page.mouse.up();
        };
        await page.setViewportSize({ width: 1440, height: 960 });
        await open();
        const initial = await bounds();
        assert.ok(initial.outerHandle && initial.handleRight > initial.right && initial.handleBottom > initial.bottom);
        await drag(140, 230);
        const expanded = await bounds();
        assert.ok(expanded.width > initial.width + 100, JSON.stringify({ initial, expanded }));
        assert.ok(expanded.promptHeight > 250);
        assert.ok(Math.abs(expanded.x - initial.x) < 2 && Math.abs(expanded.y - initial.y) < 2, 'Resize must not recenter the panel');
        await page.keyboard.press('Escape'); await open();
        const reopened = await bounds();
        assert.ok(Math.abs(reopened.width - expanded.width) < 2 && Math.abs(reopened.promptHeight - expanded.promptHeight) < 2);
        await page.locator('.generation-composer-resize').focus(); await page.keyboard.press('ArrowRight');
        assert.ok((await bounds()).width > reopened.width + 10);
        const beforeWrap = await bounds();
        await drag(-380, 0);
        assert.ok(Math.abs((await bounds()).height - beforeWrap.height) < 2, 'Toolbar wrapping must not move the outer resize corner vertically');
        await drag(-100, -180);
        assert.ok((await bounds()).width < 600, 'Width can be smaller than the old 680px minimum');
        const saved = await bounds();
        await app.close(); app = await launch(); page = await mainPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.setViewportSize({ width: 1440, height: 960 }); await open();
        assert.ok(Math.abs((await bounds()).width - saved.width) < 2, 'Size survives restart');
        const output = path.join(root, 'output/playwright'); await fs.mkdir(output, { recursive: true });
        for (const [theme, width, height] of [['dark', 1440, 960], ['light', 1440, 960], ['dark', 820, 680]]) {
            await page.setViewportSize({ width, height });
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            await page.waitForTimeout(150);
            await drag(1400, 1400);
            const rect = await bounds();
            assert.ok(rect.right <= width && rect.bottom <= height && !rect.overflow, JSON.stringify(rect));
            assert.ok(rect.submitRight <= width && rect.submitBottom <= height, JSON.stringify(rect));
            assert.ok(rect.handleRight <= width && rect.handleBottom <= height, JSON.stringify(rect));
            await page.screenshot({ path: path.join(output, `composer-resize-${theme}-${width}.png`) });
        }
        await page.locator('.generation-composer-resize').dblclick();
        assert.equal(await page.evaluate(() => localStorage.getItem('flow-canvas:composer-size')), null);
        assert.deepEqual(errors, []);
        console.log('PASS composer resize: horizontal/vertical drag, stable origin, compact controls, keyboard, restart persistence, viewport limits, reset.');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
