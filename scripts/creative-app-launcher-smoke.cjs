const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-creative-apps-'));
    const screenshotDir = path.resolve(__dirname, '../output/playwright');
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        await fs.mkdir(screenshotDir, { recursive: true });
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items: [], folderGroups: [], mcp: { enabled: false } }));
        const env = { ...process.env, FLOW_HUNYUAN_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: [path.join(__dirname, 'hunyuan-smoke-entry.cjs')], env });
        let page;
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => document.querySelector('#corvasAppLauncher'));
        const menu = page.locator('#corvasAppLauncher');
        const openMenu = async () => {
            await page.bringToFront();
            await page.mouse.move(2, 2);
            await page.locator('#agentToggleBtn').hover();
            await menu.waitFor({ state: 'visible' });
        };
        await openMenu();
        assert.deepEqual(await menu.locator('[role="group"]').evaluateAll(groups => groups.map(group => ({
            name: group.getAttribute('aria-label'), apps: [...group.querySelectorAll('[data-app]')].map(button => button.dataset.app)
        }))), [{ name: 'AI 助手', apps: ['agent'] }, { name: '网页创作', apps: ['tripo', 'hunyuan', 'jimeng'] },
            { name: '本地软件', apps: ['rhino', 'blender'] }]);
        await page.waitForFunction(() => [...document.querySelectorAll('#corvasAppLauncher img')].every(image => image.complete && image.naturalWidth > 1));
        assert.equal(await menu.locator('img').count(), 5);
        for (const [theme, width, height] of [['dark', 1440, 960], ['light', 1440, 960], ['dark', 640, 620]]) {
            await (await app.browserWindow(page)).evaluate((window, size) => {
                window.setMinimumSize(400, 400); window.setSize(...size);
            }, [width, height]);
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            await openMenu();
            const problems = await menu.evaluate(element => {
                const bounds = element.getBoundingClientRect();
                return { outside: bounds.left < 0 || bounds.top < 0 || bounds.right > innerWidth || bounds.bottom > innerHeight,
                    overflow: [...element.querySelectorAll('button')].some(button => button.scrollWidth > button.clientWidth + 1) };
            });
            assert.deepEqual(problems, { outside: false, overflow: false });
            await menu.screenshot({ path: path.join(screenshotDir, `creative-apps-${theme}-${width}.png`) });
        }
        await menu.locator('[data-app="agent"]').focus();
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.app), 'tripo');
        await page.keyboard.press('End');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.app), 'blender');
        await page.keyboard.press('Escape');
        assert.equal(await menu.isVisible(), false);

        await openMenu();
        const tripoPromise = app.waitForEvent('window');
        await menu.locator('[data-app="tripo"]').click();
        const tripo = await tripoPromise;
        await tripo.waitForURL('https://studio.tripo3d.ai/');
        assert.equal(await tripo.evaluate(() => typeof window.flowCanvas), 'undefined');
        await tripo.evaluate(() => { localStorage.setItem('creative-draft', 'tripo'); window.draft = 'keep'; });
        await openMenu();
        await menu.locator('[data-app="tripo"]').click();
        assert.equal(app.windows().filter(window => window.url().startsWith('https://studio.tripo3d.ai/')).length, 1);
        assert.equal(await tripo.evaluate(() => window.draft), 'keep');
        const preferences = await (await app.browserWindow(tripo)).evaluate(window => {
            const prefs = window.webContents.getLastWebPreferences();
            return { sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, preload: prefs.preload };
        });
        assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false);
        assert.equal(preferences.contextIsolation, true); assert.ok(!preferences.preload);

        await openMenu();
        const jimengPromise = app.waitForEvent('window');
        await menu.locator('[data-app="jimeng"]').click();
        const jimeng = await jimengPromise;
        await jimeng.waitForURL('https://jimeng.jianying.com/ai-tool/home');
        assert.equal(await jimeng.evaluate(() => localStorage.getItem('creative-draft')), null);
        assert.equal(await jimeng.evaluate(() => typeof window.flowCanvas), 'undefined');
        const popupPromise = tripo.waitForEvent('popup');
        await tripo.getByText('Login popup').click();
        const popup = await popupPromise;
        await popup.waitForURL('https://xui.ptlogin2.qq.com/');
        assert.equal(await popup.evaluate(() => typeof window.flowCanvas), 'undefined');
        await popup.close();
        await tripo.close();
        await openMenu();
        const reopen = app.waitForEvent('window');
        await menu.locator('[data-app="tripo"]').click();
        const restored = await reopen;
        await restored.waitForURL('https://studio.tripo3d.ai/');
        assert.equal(await restored.evaluate(() => localStorage.getItem('creative-draft')), 'tripo');
        const invalid = await page.evaluate(() => window.flowCanvas.creativeWeb.open('https://other.example').then(() => false, () => true));
        assert.equal(invalid, true);
        await openMenu();
        await menu.locator('[data-app="hunyuan"]').click();
        await page.locator('#hunyuanAccountsPanel').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#hunyuanAccountsPanel .hunyuan-panel-head img').count(), 1);
        assert.deepEqual(errors, []);
        console.log('PASS creative apps: groups, local brand icons, dark/light/compact layout, keyboard navigation, web opening/reuse, isolated persistent sessions and sandboxed login popups.');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
