const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-context-menu-'));
    let app, page;
    const errors = [];
    try {
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(path.join(profile, 'data/relay-browser.json'), JSON.stringify({ onboardingSkipped: true }));
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'context',
            items: [], connections: [], folderGroups: [{ id: 'context', name: 'Context test', folders: [], savedItems: [], connections: [] }],
            mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile, FLOW_SOURCE_SMOKE: '1' };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: ['--disable-gpu', path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        for (let i = 0; i < 100; i++) {
            page = app.windows().find(window => window.url().startsWith('http://127.0.0.1:15321/'));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'Source renderer must open');
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => window.Konva?.stages[0]);
        await page.locator('#siteLoginDialog[open] [data-login-skip]').click();
        await page.evaluate(() => {
            window.__contextEvents = [];
            for (const type of ['mousedown', 'pointerup', 'mouseup', 'contextmenu']) {
                document.addEventListener(type, event => window.__contextEvents.push({ type, button: event.button,
                    target: event.target.tagName, x: event.clientX, y: event.clientY, prevented: event.defaultPrevented }), true);
            }
        });
        const box = await page.locator('#canvasContainer').boundingBox();
        const point = { x: box.x + box.width * 0.65, y: box.y + 120 };
        const menu = page.locator('.insert-node-menu');
        await page.mouse.click(point.x, point.y, { button: 'right' });
        await menu.waitFor({ state: 'visible', timeout: 2000 });
        await menu.getByRole('button', { name: '空图片', exact: true }).click();
        await page.waitForFunction(() => window.Konva.stages[0].find('.nodeGroup').length === 1);
        const blank = { x: box.x + 100, y: box.y + 100 };
        await page.mouse.move(blank.x, blank.y);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(blank.x + 1, blank.y + 1);
        await page.mouse.up({ button: 'right' });
        await menu.waitFor({ state: 'visible', timeout: 2000 });
        await page.mouse.click(blank.x + 230, blank.y + 200);
        await menu.waitFor({ state: 'detached' });
        const before = await page.evaluate(() => window.Konva.stages[0].position());
        await page.mouse.move(blank.x, blank.y);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(blank.x + 80, blank.y + 40, { steps: 8 });
        await page.mouse.up({ button: 'right' });
        assert.equal(await menu.count(), 0, 'Dragging does not open the node menu');
        const after = await page.evaluate(() => window.Konva.stages[0].position());
        assert.ok(Math.abs(after.x - before.x - 80) < 2 && Math.abs(after.y - before.y - 40) < 2);
        await page.mouse.click(blank.x, blank.y, { button: 'right' });
        await menu.waitFor({ state: 'visible', timeout: 2000 });
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/canvas-context-menu.png') });
        assert.deepEqual(await menu.locator('button').allTextContents(), ['空图片', '文本生成 / 合并', '图像生成', '视频生成', '批量处理']);
        for (const theme of ['dark', 'light']) {
            await page.evaluate(theme => {
                const root = document.documentElement;
                root.dataset.theme = theme;
                root.style.setProperty('--accent', '#ffffff');
                root.style.setProperty('--accent-strong', '#ffffff');
            }, theme);
            await menu.getByRole('button', { name: '空图片', exact: true }).hover();
            await page.waitForTimeout(150);
            const contrast = await menu.locator('button').first().evaluate(button => {
                const context = document.createElement('canvas').getContext('2d');
                const luminance = color => {
                    context.fillStyle = color;
                    context.fillRect(0, 0, 1, 1);
                    const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
                        const channel = value / 255;
                        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                    });
                    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
                };
                const style = getComputedStyle(button);
                const text = luminance(style.color), background = luminance(style.backgroundColor);
                return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
            });
            assert.ok(contrast >= 4.5, `${theme} hover text contrast is ${contrast}`);
            assert.equal(await menu.evaluate(element => element.scrollWidth > element.clientWidth), false);
            await menu.screenshot({ path: path.join(__dirname, `../output/playwright/canvas-insert-menu-${theme}.png`) });
        }
        const edge = await page.evaluate(() => ({ x: innerWidth - 14, y: innerHeight - 22 }));
        await page.mouse.click(edge.x, edge.y, { button: 'right' });
        await menu.waitFor({ state: 'visible', timeout: 2000 });
        const fits = await menu.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
        });
        assert.equal(fits, true, 'Node menu stays inside the viewport near the window edge');
        assert.deepEqual(errors, []);
        console.log('PASS source canvas context menu: right click, node creation, slight movement, right drag, themed hover contrast and viewport bounds.');
    } catch (error) {
        if (page && !page.isClosed()) console.error(JSON.stringify({ errors, events: await page.evaluate(() => window.__contextEvents) }));
        throw error;
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
