const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { SITES, identifier, publicTask } = require('./relay-browser-contract.cjs');
const { listRelayAccounts, resolveRelayAccounts } = require('./relay-account-link.cjs');
const { RelaySessionStore, sessionStorageScript, restoreSessionCookies, restoreSessionStorage } = require('./relay-session-store.cjs');

const fail = message => Object.assign(new Error(message), { publicMessage: message });
const MAX_BYTES = 512 * 1024 * 1024;

async function bounded(work, milliseconds = 10000) {
    let timer;
    try {
        return await Promise.race([work, new Promise((_, reject) => {
            timer = setTimeout(() => reject(fail('网页尚未就绪，请稍后重试')), milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}

class RelayBrowser {
    constructor({ BrowserWindow, BrowserView, session, shell, directory, importer, sites = SITES, onAccount, onSelectAccounts, getLinkedAccounts, onState, safeStorage }) {
        Object.assign(this, { BrowserWindow, BrowserView, session, shell, directory, importer, sites, onAccount, onSelectAccounts, getLinkedAccounts, onState });
        this.sessionStore = new RelaySessionStore({ directory, safeStorage });
        this.restoringSites = new Set();
        this.loggedOutSites = new Set();
        this.logoutAuth = new Map();
        this.sessionErrors = new Map();
        this.sessionSaves = new Map();
        this.window = null;
        this.views = new Map();
        this.sessions = new Map();
        this.queries = new Map();
        this.jobs = new Map();
        this.site = null;
        this.focus = null;
        this.status = '';
        this.accountStates = new Map();
        this.accountAuth = new Map();
        this.accountChecks = new Set();
        this.accountManualPending = new Set();
        this.capturedAuth = new Map();
        this.preferences = {};
        this.preferenceFile = path.join(directory, 'relay-browser.json');
        try {
            const saved = JSON.parse(fs.readFileSync(this.preferenceFile, 'utf8'));
            this.preferences = saved;
            if (Object.hasOwn(sites, saved.site)) this.site = saved.site;
        } catch { /* First launch starts with the site picker. */ }
    }

    send(status) {
        if (status !== undefined) this.status = status;
        this.onState?.(this.snapshot());
        if (!this.window || this.window.isDestroyed()) return;
        this.window.webContents.send('relay-browser:state', { site: this.site,
            siteName: this.sites[this.site]?.name || '', taskId: this.focus?.site === this.site ? this.focus.taskId : '',
            status: this.status || this.sessionErrors.get(this.site) || '', account: this.accountStates.get(this.site) || { state: 'signed-out' } });
    }

    snapshot() {
        return { site: this.site || this.preferences.site || null, onboardingSkipped: this.preferences.onboardingSkipped === true,
            accounts: Object.fromEntries(this.accountStates) };
    }

    savePreferences(patch) {
        this.preferences = { ...this.preferences, ...patch };
        fs.mkdirSync(this.directory, { recursive: true });
        const temporary = this.preferenceFile + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(this.preferences));
        fs.renameSync(temporary, this.preferenceFile);
    }

    skipOnboarding() { this.savePreferences({ onboardingSkipped: true }); return this.snapshot(); }

    async open({ site, taskId, clientTaskId, login = false } = {}) {
        if (this.windowClosing) await this.windowClosing;
        if (!this.window || this.window.isDestroyed()) {
            this.window = new this.BrowserWindow({ width: 1280, height: 880, minWidth: 620, minHeight: 500,
                title: '站点后台 · Corvas', backgroundColor: '#191b1e', autoHideMenuBar: true,
                webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
                    preload: path.join(__dirname, 'relay-browser-preload.cjs') } });
            this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            this.window.webContents.on('will-navigate', event => event.preventDefault());
            this.window.webContents.on('will-attach-webview', event => event.preventDefault());
            this.window.on('resize', () => this.layout());
            const window = this.window;
            let readyToClose = false;
            window.on('close', event => {
                if (readyToClose) return;
                event.preventDefault();
                this.windowClosing ||= this.flushSessions().finally(() => {
                    readyToClose = true;
                    if (!window.isDestroyed()) window.close();
                    this.windowClosing = null;
                });
            });
            this.window.on('closed', () => {
                clearInterval(this.accountTimer);
                this.accountAuth.clear(); this.accountStates.clear();
                this.capturedAuth.clear();
                for (const view of this.views.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
                this.views.clear(); this.window = null;
            });
            await this.window.loadFile(path.join(__dirname, 'relay-browser.html'));
            this.accountTimer = setInterval(() => {
                for (const site of this.views.keys()) void this.saveSession(site);
                if (this.onAccount) void this.checkAccount();
            }, 2000);
        }
        if (this.window.isMinimized()) this.window.restore();
        this.window.show(); this.window.focus();
        if (site || this.site) await this.selectSite(site || this.site, { selectKeys: login });
        if (taskId) {
            this.focus = { site: this.site, taskId: identifier(taskId), clientTaskId: clientTaskId || null };
            void this.navigate('/task-logs');
        }
        this.send();
        return { opened: true };
    }

    layout() {
        if (!this.window || this.window.isDestroyed()) return;
        const view = this.views.get(this.site);
        this.window.setBrowserView(view || null);
        if (view) {
            const [width, height] = this.window.getContentSize();
            view.setBounds({ x: 0, y: 56, width, height: Math.max(1, height - 56) });
        }
    }

    sameOrigin(site, value) {
        try { return new URL(value).origin === this.sites[site].origin; } catch { return false; }
    }

    async selectSite(site, { selectKeys = false } = {}) {
        if (!Object.hasOwn(this.sites, site)) throw fail('请选择生图站、视频站或企业站');
        if (site !== this.site) this.focus = null;
        this.site = site;
        this.savePreferences({ site });
        if (!this.views.has(site)) {
            const browserSession = this.session.fromPartition(`persist:corvas-relay-${site}`);
            this.restoringSites.add(site);
            const view = new this.BrowserView({ webPreferences: { session: browserSession,
                sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
            this.views.set(site, view);
            const web = view.webContents;
            web.on('will-attach-webview', event => event.preventDefault());
            const external = url => {
                try { if (new URL(url).protocol === 'https:') void this.shell.openExternal(url); } catch { /* Invalid URL. */ }
            };
            for (const name of ['will-navigate', 'will-redirect']) web.on(name, (event, url) => {
                if (!this.sameOrigin(site, url)) { event.preventDefault(); external(url); }
            });
            web.setWindowOpenHandler(({ url }) => {
                if (this.sameOrigin(site, url)) void web.loadURL(url).catch(() => {});
                else external(url);
                return { action: 'deny' };
            });
            const navigated = () => {
                if (this.focus?.site !== site || !this.sameOrigin(site, web.getURL())) return;
                const pathname = new URL(web.getURL()).pathname;
                if (['/', '/dashboard', '/home', '/home-pro'].includes(pathname)) void this.navigate('/task-logs');
            };
            web.on('did-navigate-in-page', navigated);
            web.on('did-finish-load', navigated);
            web.on('did-finish-load', () => { if (site === this.site) void this.checkAccount(); });
            web.on('did-start-loading', () => { if (site === this.site) this.send('正在加载网页…'); });
            web.on('did-stop-loading', () => { if (site === this.site && this.status === '正在加载网页…') this.send(''); });
            web.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
                if (isMainFrame && code !== -3 && site === this.site) this.send(`网页加载失败（${code}），可点击刷新重试`);
            });
            this.watchSession(site, browserSession);
            this.layout();
            let saved;
            try {
                saved = this.sessionStore.get(site, this.sites[site].origin);
                await restoreSessionCookies(browserSession, saved, this.sites[site].origin);
            } catch { this.sessionErrors.set(site, '登录状态未能恢复，请检查系统凭据服务'); }
            try {
                await web.loadURL(this.sites[site].origin + (this.sites[site].homePath || '/dashboard'));
                if (this.views.get(site) === view && this.sameOrigin(site, web.getURL())
                    && await restoreSessionStorage(web, saved, this.sites[site].origin)) {
                    await web.loadURL(this.sites[site].origin + (this.sites[site].homePath || '/dashboard'));
                }
            } catch (error) { if (error.code !== 'ERR_ABORTED') this.send('网页打开失败，请刷新重试'); }
            finally { this.restoringSites.delete(site); }
        }
        this.layout(); this.send();
        void this.checkAccount(selectKeys);
    }

    async readAccountAuth(site, web) {
        if (!web || web.isDestroyed() || !this.sameOrigin(site, web.getURL())) return '';
        if (site === 'ai') return this.capturedAuth.get(site) || '';
        const token = await bounded(web.executeJavaScript("sessionStorage.getItem('token') || localStorage.getItem('token') || ''"));
        if (web.isDestroyed() || !this.sameOrigin(site, web.getURL())) return '';
        return typeof token === 'string' && token.length <= 16384 ? token : '';
    }

    async checkAccount(manual = false) {
        const site = this.site, web = this.views.get(site)?.webContents;
        if (!this.onAccount || !site || !web || this.restoringSites.has(site)) return;
        if (this.accountChecks.has(site)) {
            if (manual && this.accountStates.get(site)?.state !== 'selecting') this.accountManualPending.add(site);
            return;
        }
        this.accountChecks.add(site);
        try {
            const auth = await this.readAccountAuth(site, web);
            if (!auth) {
                if (this.accountAuth.has(site)) this.forgetSession(site);
                this.accountAuth.delete(site);
                this.accountStates.set(site, { state: 'signed-out', message: '请先登录站点' });
                if (site === this.site) this.send();
                if (manual) void this.navigate(this.sites[site].loginPath || '/login');
                return;
            }
            const fingerprint = crypto.createHash('sha256').update(auth).digest('hex');
            if (!manual && this.accountAuth.get(site) === fingerprint) return;
            this.accountAuth.set(site, fingerprint);
            this.loggedOutSites.delete(site);
            this.accountStates.set(site, { state: 'connecting', message: '正在读取 API Key' });
            if (site === this.site) this.send();
            const stillCurrent = async () => this.site === site && this.views.get(site)?.webContents === web
                && !web.isDestroyed() && await this.readAccountAuth(site, web) === auth;
            const options = { site, origin: this.sites[site].origin, session: web.session, auth, stillCurrent };
            const catalog = await listRelayAccounts(options);
            const previous = this.getLinkedAccounts?.(site, catalog.userId) || [];
            const linked = new Set(previous.map(account => account.tokenId));
            const alreadySeen = this.preferences.keyPickerSeen?.[site] === catalog.userId;
            if (manual || (!alreadySeen && !linked.size)) {
                if (!this.onSelectAccounts) throw fail('请重启画布后选择 API Key');
                this.savePreferences({ keyPickerSeen: { ...this.preferences.keyPickerSeen, [site]: catalog.userId } });
                this.accountStates.set(site, { state: 'selecting', username: catalog.username, message: '等待选择 API Key' });
                this.accountManualPending.delete(site);
                this.send();
                const tokenIds = await this.onSelectAccounts({ ...catalog, tokens: catalog.tokens.map(token => ({ ...token, imported: linked.has(token.id) })) });
                if (!await stillCurrent()) return;
                if (tokenIds?.length) {
                    const accounts = await resolveRelayAccounts(options, { userId: catalog.userId, tokenIds });
                    if (!await stillCurrent()) return;
                    await this.onAccount(accounts);
                    accounts.forEach(account => linked.add(account.tokenId));
                }
            }
            this.accountStates.set(site, { state: linked.size ? 'connected' : 'signed-in', username: catalog.username,
                message: linked.size ? `已导入 ${linked.size} 个 API Key` : '已登录，尚未导入 API Key' });
            await this.saveSession(site);
        } catch (error) {
            if (error.code === 'RELAY_AUTH_EXPIRED') this.forgetSession(site);
            this.accountStates.set(site, { state: 'error', message: error.publicMessage || '连接未完成，请点击连接画布重试' });
        } finally {
            this.accountChecks.delete(site);
            if (site === this.site) this.send();
            if (this.accountManualPending.delete(site) && site === this.site && this.views.get(site)?.webContents === web && !web.isDestroyed()) {
                void this.checkAccount(true);
            }
        }
    }

    forgetSession(site) {
        this.loggedOutSites.add(site);
        const auth = this.capturedAuth.get(site);
        if (auth) this.logoutAuth.set(site, crypto.createHash('sha256').update(auth).digest('hex'));
        try { this.sessionStore.clear(site); }
        catch { this.sessionErrors.set(site, '登录状态未能清除，请检查系统凭据服务'); }
    }

    async saveSession(site) {
        if (this.restoringSites.has(site) || this.loggedOutSites.has(site)) return;
        if (this.sessionSaves.has(site)) return this.sessionSaves.get(site);
        const web = this.views.get(site)?.webContents;
        if (!web || web.isDestroyed() || !this.sameOrigin(site, web.getURL()) || web.isLoadingMainFrame()) return;
        const work = (async () => {
            const storage = await bounded(web.executeJavaScript(sessionStorageScript(this.sites[site].origin)));
            if (!storage || web.isDestroyed() || !this.sameOrigin(site, web.getURL()) || this.loggedOutSites.has(site)) return;
            if (site !== 'ai' && !await this.readAccountAuth(site, web)) { this.forgetSession(site); return; }
            const cookies = await web.session.cookies.get({ url: this.sites[site].origin });
            if (this.loggedOutSites.has(site)) return;
            this.sessionStore.save(site, this.sites[site].origin, { storage, cookies });
            web.session.flushStorageData();
            await web.session.cookies.flushStore();
            this.sessionErrors.delete(site);
        })().catch(() => { this.sessionErrors.set(site, '登录状态未能加密保存，请检查系统凭据服务'); })
            .finally(() => this.sessionSaves.delete(site));
        this.sessionSaves.set(site, work);
        return work;
    }

    async flushSessions() {
        // A close must capture the final storage state, not reuse a pre-logout snapshot.
        await Promise.allSettled([...this.sessionSaves.values()]);
        await Promise.allSettled([...this.views.keys()].map(site => this.saveSession(site)));
        await Promise.allSettled([...this.sessions.values()].map(async ({ browserSession }) => {
            browserSession.flushStorageData();
            await browserSession.cookies.flushStore();
        }));
    }

    async navigate(route) {
        const web = this.views.get(this.site)?.webContents;
        if (!web) return;
        try { await web.loadURL(`${this.sites[this.site].origin}${route}`); }
        catch (error) { if (error.code !== 'ERR_ABORTED') this.send('网页打开失败，请刷新重试'); }
    }

    watchSession(site, browserSession) {
        if (this.sessions.has(site)) return;
        browserSession.webRequest.onBeforeSendHeaders({ urls: [`${this.sites[site].origin}/api/*`] }, (details, callback) => {
                const web = this.views.get(site)?.webContents;
                const frame = details.frame;
                if (web && !web.isDestroyed() && details.webContentsId === web.id && frame
                    && frame.processId === web.mainFrame.processId && frame.routingId === web.mainFrame.routingId
                    && this.sameOrigin(site, frame.url) && this.sameOrigin(site, web.getURL())) {
                    if (['/api/user/auth/logout', '/api/v1/auth/logout'].includes(new URL(details.url).pathname)) {
                        this.forgetSession(site);
                        this.capturedAuth.delete(site); this.accountAuth.delete(site);
                    } else if (site === 'ai') {
                        const value = Object.entries(details.requestHeaders).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
                        if (typeof value === 'string' && /^Bearer [^\s]{1,16384}$/.test(value)) {
                            const auth = value.slice(7);
                            if (!this.loggedOutSites.has(site) || crypto.createHash('sha256').update(auth).digest('hex') !== this.logoutAuth.get(site)) {
                                this.capturedAuth.set(site, auth);
                                this.loggedOutSites.delete(site);
                            }
                        }
                    }
                }
                callback({ requestHeaders: details.requestHeaders });
        });
        // Keep the station's own task UI. Only a canvas deep link adds an exact task
        // filter to its existing request; the toolbar makes that filter removable.
        browserSession.webRequest.onBeforeRequest({ urls: [`${this.sites[site].origin}/api/v1/task_logs*`] }, (details, callback) => {
            const url = new URL(details.url);
            const view = this.views.get(site);
            if (url.pathname !== '/api/v1/task_logs' || details.webContentsId !== view?.webContents.id || details.method !== 'GET') {
                callback({}); return;
            }
            if (this.focus?.site === site) {
                url.searchParams.set('task_id', this.focus.taskId);
                for (const key of ['start_date', 'end_date', 'model', 'search_keyword']) url.searchParams.delete(key);
                if (url.href !== details.url) { callback({ redirectURL: url.href }); return; }
            }
            this.queries.set(site, url.search);
            callback({});
        });
        const listener = (_event, item, web) => {
            if (web !== this.views.get(site)?.webContents || !this.sameOrigin(site, web.getURL())) return;
            const mime = item.getMimeType();
            if (!mime.startsWith('video/') && !/\.(mp4|webm|mov)$/i.test(item.getFilename())) return;
            const id = crypto.randomUUID();
            const directory = path.join(this.directory, 'relay-downloads');
            fs.mkdirSync(directory, { recursive: true });
            const filePath = path.join(directory, `${id}.mp4`);
            item.setSavePath(`${filePath}.part`);
            const job = { id, site, item, status: 'downloading', filePath };
            this.jobs.set(id, job);
            const query = this.queries.get(site) || '?page=1&per_page=50&action_type=video';
            const projectId = this.importer.currentProjectId();
            const focus = this.focus?.site === site ? { ...this.focus } : null;
            const lookup = this.matchTask(site, query, item.getURLChain(), focus, projectId).then(context => {
                if (context && ['downloading', 'completed'].includes(job.status)) this.importer.start(context);
                return context;
            }).catch(() => null);
            this.send('正在下载视频…');
            item.on('updated', () => {
                if (item.getReceivedBytes() > MAX_BYTES || item.getTotalBytes() > MAX_BYTES) { item.cancel(); return; }
                if (site === this.site) this.send(`正在下载视频 ${(item.getReceivedBytes() / 1048576).toFixed(1)} MB`);
            });
            item.once('done', (_event, state) => {
                job.status = state;
                this.jobs.delete(id);
                if (state !== 'completed') {
                    void fs.promises.unlink(`${filePath}.part`).catch(() => {});
                    this.send('视频下载未完成，可在原站重新下载'); return;
                }
                void (async () => {
                    await fs.promises.rename(`${filePath}.part`, filePath);
                    const context = await lookup;
                    if (!context) {
                        this.send('视频已下载，未能关联任务，已打开文件位置');
                        this.shell.showItemInFolder(filePath); return;
                    }
                    if (!context.existingPath) await fs.promises.copyFile(filePath, context.filePath);
                    await this.importer.finish(context, context.existingPath || context.filePath);
                    await fs.promises.unlink(filePath);
                    this.send('视频已导入画布');
                })().catch(() => { this.send('视频已下载，画布回填未完成，已保留文件'); this.shell.showItemInFolder(filePath); });
            });
        };
        browserSession.on('will-download', listener);
        this.sessions.set(site, { browserSession, listener });
    }

    async matchTask(site, query, urls, focus, projectId) {
        if (site === 'ai') return null;
        const web = this.views.get(site)?.webContents;
        if (!web || web.isDestroyed() || !this.sameOrigin(site, web.getURL())) return null;
        const token = await bounded(web.executeJavaScript("sessionStorage.getItem('token') || localStorage.getItem('token') || ''"));
        if (typeof token !== 'string' || !token || token.length > 16384) return null;
        const response = await web.session.fetch(`${this.sites[site].origin}/api/v1/task_logs${query}`, {
            redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) return null;
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) return null;
            chunks.push(Buffer.from(chunk));
        }
        const data = JSON.parse(Buffer.concat(chunks).toString()).data;
        const matches = (Array.isArray(data) ? data : []).filter(row => row.user_id
            && publicTask(row).status === 'completed' && row.preview_urls?.some(url => urls.includes(url)));
        if (matches.length !== 1) return null;
        const row = matches[0];
        const index = row.preview_urls.findIndex(url => urls.includes(url));
        return this.importer.prepare({ site, task: publicTask(row), accountId: String(row.user_id), index, projectId,
            clientTaskId: focus?.taskId === row.task_id ? focus.clientTaskId : null });
    }

    async command(event, action, value = {}) {
        if (event.sender !== this.window?.webContents || event.senderFrame !== this.window.webContents.mainFrame
            || event.sender.getURL() !== pathToFileURL(path.join(__dirname, 'relay-browser.html')).href) throw new Error('Invalid relay browser sender');
        try {
            const web = this.views.get(this.site)?.webContents;
            switch (action) {
                case 'state': this.send(); break;
                case 'choose': await this.selectSite(value.site); break;
                case 'switch': this.site = null; this.focus = null; this.layout(); this.send(''); break;
                case 'clear-task': this.focus = null; this.send(''); web?.reload(); break;
                case 'back': if (web?.canGoBack()) web.goBack(); break;
                case 'forward': if (web?.canGoForward()) web.goForward(); break;
                case 'reload': web?.reload(); break;
                case 'home': this.focus = null; void this.navigate(this.sites[this.site].homePath || '/dashboard'); this.send(); break;
                case 'logs': void this.navigate(this.sites[this.site].logsPath || '/task-logs'); break;
                case 'connect': await this.checkAccount(true); break;
                default: throw fail('未知操作');
            }
            return { ok: true };
        } catch (error) { return { ok: false, error: error.publicMessage || '操作未完成，请重试' }; }
    }

    async close() {
        clearInterval(this.accountTimer);
        for (const job of this.jobs.values()) if (job.status === 'downloading') job.item.cancel();
        await this.flushSessions();
        for (const { browserSession, listener } of this.sessions.values()) {
            browserSession.flushStorageData?.();
            browserSession.removeListener('will-download', listener);
            browserSession.webRequest.onBeforeRequest(null);
            browserSession.webRequest.onBeforeSendHeaders(null);
        }
        this.sessions.clear();
        if (this.window && !this.window.isDestroyed()) this.window.close();
        if (this.windowClosing) await this.windowClosing;
    }
}

module.exports = { RelayBrowser };
