const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron, chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-hunyuan-ui-'));
    const screenshotDir = path.resolve(__dirname, '../output/playwright');
    let app, page;
    const browsers = new Map();
    const launch = async () => {
        const env = { ...process.env, FLOW_HUNYUAN_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: [path.join(__dirname, 'hunyuan-smoke-entry.cjs')], env });
        if (process.env.FLOW_HUNYUAN_SMOKE_LIVE === '1') app.on('window', window => {
            window.on('pageerror', error => console.error('Web page error:', error.message));
            window.on('requestfailed', request => console.error('Web request failed:', new URL(request.url()).hostname, request.failure()?.errorText));
        });
        for (let i = 0; i < 150; i++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'Main window opens');
        await page.waitForFunction(() => document.querySelector('#hunyuanAccountsPanel'));
    };
    const panel = () => page.locator('#hunyuanAccountsPanel');
    const openPanel = async () => {
        await page.bringToFront();
        await page.locator('#agentToggleBtn').hover();
        await page.locator('#corvasAppLauncher [data-app="hunyuan"]').click();
        await panel().waitFor({ state: 'visible' });
    };
    const add = async name => {
        await panel().locator('[data-action="add"]').click();
        await page.locator('#hunyuanAccountName').fill(name);
        await panel().locator('button[type="submit"]').click();
        await page.waitForFunction(value => [...document.querySelectorAll('.hunyuan-account-copy strong')].some(el => el.textContent === value), name);
    };
    const openAccount = async id => {
        await page.bringToFront();
        await page.locator(`[data-account-id="${id}"] [data-action="open"]`).click();
        let browser = browsers.get(id);
        for (let i = 0; i < 150; i++) {
            if (!browser) {
                try {
                    const port = (await fs.readFile(path.join(profile, 'data/hunyuan-browser-profiles', id, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
                    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
                    browsers.set(id, browser);
                } catch { /* The isolated browser is still starting. */ }
            }
            const window = browser?.contexts()[0]?.pages().find(window => window.url().startsWith('https://3d.hunyuan.tencent.com/'));
            if (window) {
                await window.waitForLoadState('domcontentloaded');
                return window;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Hunyuan window did not open');
    };
    try {
        await fs.mkdir(path.join(profile, 'data'));
        await fs.mkdir(screenshotDir, { recursive: true });
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items: [], folderGroups: [], mcp: { enabled: false } }));
        await launch();
        await openPanel();
        await add('产品设计');
        await add('概念探索');
        const accounts = await page.evaluate(() => window.flowCanvas.hunyuan.list());
        assert.equal(accounts.accounts.length, 2);
        const [a, b] = accounts.accounts;
        const first = await openAccount(a.id);
        assert.equal(await first.evaluate(() => typeof window.flowCanvas), 'undefined');
        if (process.env.FLOW_HUNYUAN_SMOKE_LIVE === '1') {
            try {
                await first.getByText('登录', { exact: true }).first().waitFor({ state: 'visible', timeout: 45000 });
            } finally {
                await first.screenshot({ path: path.join(screenshotDir, 'hunyuan-official-web.png') });
                console.log('Official page text:', await first.locator('body').innerText());
            }
            await first.screenshot({ path: path.join(screenshotDir, 'hunyuan-official-web.png') });
            console.log('Official page opened:', first.url(), 'title:', await first.title());
            console.log(await first.locator('body').innerText());
            return;
        }
        await first.evaluate(() => { localStorage.setItem('test-account', 'A'); document.cookie = 'fixture_account=A;max-age=86400;Secure;SameSite=Lax'; });
        const second = await openAccount(b.id);
        assert.equal(await second.evaluate(() => localStorage.getItem('test-account')), null);
        assert.equal(await second.evaluate(() => document.cookie.includes('fixture_account=A')), false);
        await second.evaluate(() => localStorage.setItem('test-account', 'B'));
        await page.bringToFront();
        await page.locator(`[data-account-id="${a.id}"] [data-action="open"]`).click();
        assert.equal(first.context().pages().length, 1);
        assert.equal(second.context().pages().length, 1);
        assert.notEqual(first.context().browser(), second.context().browser());
        const popupPromise = first.waitForEvent('popup');
        await first.bringToFront();
        await first.getByText('Login popup').click();
        const popup = await popupPromise;
        await popup.waitForLoadState('domcontentloaded');
        assert.equal(popup.context(), first.context());
        await popup.evaluate(() => localStorage.setItem('login-account', 'A'));
        await second.bringToFront();
        const secondPopupPromise = second.waitForEvent('popup');
        await second.getByText('Login popup').click();
        const secondPopup = await secondPopupPromise;
        await secondPopup.waitForLoadState('domcontentloaded');
        assert.equal(secondPopup.context(), second.context());
        assert.equal(await secondPopup.evaluate(() => window.opener !== null), true);
        assert.equal(await secondPopup.evaluate(() => localStorage.getItem('login-account')), null);
        assert.equal(await popup.evaluate(() => localStorage.getItem('login-account')), 'A');
        await secondPopup.close();
        await popup.close();
        await page.bringToFront();
        await page.locator(`[data-account-id="${a.id}"] [data-action="rename"]`).click();
        await page.locator('#hunyuanAccountName').fill('产品主账号');
        await panel().locator('button[type="submit"]').click();
        await page.waitForFunction(() => document.querySelector('.hunyuan-account-copy strong')?.textContent === '产品主账号');
        for (const theme of ['dark', 'light']) {
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            await page.screenshot({ path: path.join(screenshotDir, `hunyuan-accounts-${theme}.png`) });
        }
        await (await app.browserWindow(page)).evaluate(win => win.setSize(820, 680));
        await page.waitForTimeout(350);
        const rect = await panel().boundingBox();
        const width = await page.evaluate(() => innerWidth);
        assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1);
        await page.screenshot({ path: path.join(screenshotDir, 'hunyuan-accounts-compact.png') });
        await panel().locator('[data-action="agent"]').click();
        assert.equal(await panel().isVisible(), false);
        assert.equal(await page.locator('#agentSidebar').isVisible(), true);
        await page.locator('#agentSidebarCloseBtn').click();
        await openPanel();
        await page.locator('#agentToggleBtn').click();
        assert.equal(await panel().isVisible(), false);
        await app.close(); app = null; page = null;
        browsers.clear();
        await launch();
        await openPanel();
        const restored = await page.evaluate(() => window.flowCanvas.hunyuan.list());
        assert.deepEqual(restored.accounts.map(account => account.id), [a.id, b.id]);
        assert.equal(restored.accounts[0].name, '产品主账号');
        const reopenedA = await openAccount(a.id);
        assert.equal(await reopenedA.evaluate(() => localStorage.getItem('test-account')), 'A');
        assert.equal(await reopenedA.evaluate(() => document.cookie.includes('fixture_account=A')), true);
        const reopenedB = await openAccount(b.id);
        assert.equal(await reopenedB.evaluate(() => localStorage.getItem('test-account')), 'B');
        await page.bringToFront();
        const row = page.locator(`[data-account-id="${a.id}"]`);
        await row.locator('[data-action="remove"]').click();
        await row.locator('[data-action="confirm-remove"]').click();
        await page.waitForFunction(id => !document.querySelector(`[data-account-id="${id}"]`), a.id);
        assert.equal(reopenedA.isClosed(), true);
        await assert.rejects(fs.stat(path.join(profile, 'data/hunyuan-browser-profiles', a.id)), { code: 'ENOENT' });
        assert.equal(await reopenedB.evaluate(() => localStorage.getItem('test-account')), 'B');
        console.log('Hunyuan UI smoke passed: launcher, account management, independent sessions, isolated login popups, restart persistence, removal, themes and compact sidebar.');
    } catch (error) {
        await page?.screenshot({ path: path.join(screenshotDir, 'hunyuan-accounts-failure.png') }).catch(() => {});
        throw error;
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
