const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { SITES, identifier, publicTask } = require('./relay-browser-contract.cjs');

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
    constructor({ BrowserWindow, BrowserView, session, shell, directory, importer, sites = SITES }) {
        Object.assign(this, { BrowserWindow, BrowserView, session, shell, directory, importer, sites });
        this.window = null;
        this.views = new Map();
        this.sessions = new Map();
        this.queries = new Map();
        this.jobs = new Map();
        this.site = null;
        this.focus = null;
        this.status = '';
        this.preferenceFile = path.join(directory, 'relay-browser.json');
        try {
            const saved = JSON.parse(fs.readFileSync(this.preferenceFile, 'utf8'));
            if (Object.hasOwn(sites, saved.site)) this.site = saved.site;
        } catch { /* First launch starts with the site picker. */ }
    }

    send(status) {
        if (status !== undefined) this.status = status;
        if (!this.window || this.window.isDestroyed()) return;
        this.window.webContents.send('relay-browser:state', { site: this.site,
            siteName: this.sites[this.site]?.name || '', taskId: this.focus?.site === this.site ? this.focus.taskId : '',
            status: this.status });
    }

    async open({ site, taskId, clientTaskId } = {}) {
        if (!this.window || this.window.isDestroyed()) {
            this.window = new this.BrowserWindow({ width: 1280, height: 880, minWidth: 620, minHeight: 500,
                title: '中转站 · Corvas', backgroundColor: '#191b1e', autoHideMenuBar: true,
                webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
                    preload: path.join(__dirname, 'relay-browser-preload.cjs') } });
            this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            this.window.webContents.on('will-navigate', event => event.preventDefault());
            this.window.webContents.on('will-attach-webview', event => event.preventDefault());
            this.window.on('resize', () => this.layout());
            this.window.on('closed', () => {
                for (const view of this.views.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
                this.views.clear(); this.window = null;
            });
            await this.window.loadFile(path.join(__dirname, 'relay-browser.html'));
        }
        if (this.window.isMinimized()) this.window.restore();
        this.window.show(); this.window.focus();
        if (site || this.site) await this.selectSite(site || this.site);
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

    async selectSite(site) {
        if (!Object.hasOwn(this.sites, site)) throw fail('请选择个人站或企业站');
        if (site !== this.site) this.focus = null;
        this.site = site;
        fs.mkdirSync(this.directory, { recursive: true });
        fs.writeFileSync(this.preferenceFile, JSON.stringify({ site }));
        if (!this.views.has(site)) {
            const browserSession = this.session.fromPartition(`persist:corvas-relay-${site}`);
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
            web.on('did-start-loading', () => { if (site === this.site) this.send('正在加载网页…'); });
            web.on('did-stop-loading', () => { if (site === this.site && this.status === '正在加载网页…') this.send(''); });
            web.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
                if (isMainFrame && code !== -3 && site === this.site) this.send(`网页加载失败（${code}），可点击刷新重试`);
            });
            this.watchSession(site, browserSession);
            this.layout();
            void this.navigate('/login');
        }
        this.layout(); this.send();
    }

    async navigate(route) {
        const web = this.views.get(this.site)?.webContents;
        if (!web) return;
        try { await web.loadURL(`${this.sites[this.site].origin}${route}`); }
        catch (error) { if (error.code !== 'ERR_ABORTED') this.send('网页打开失败，请刷新重试'); }
    }

    watchSession(site, browserSession) {
        if (this.sessions.has(site)) return;
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
                case 'home': this.focus = null; void this.navigate('/dashboard'); this.send(); break;
                case 'logs': void this.navigate('/task-logs'); break;
                default: throw fail('未知操作');
            }
            return { ok: true };
        } catch (error) { return { ok: false, error: error.publicMessage || '操作未完成，请重试' }; }
    }

    close() {
        for (const job of this.jobs.values()) if (job.status === 'downloading') job.item.cancel();
        for (const { browserSession, listener } of this.sessions.values()) {
            browserSession.removeListener('will-download', listener);
            browserSession.webRequest.onBeforeRequest(null);
        }
        this.sessions.clear();
        if (this.window && !this.window.isDestroyed()) this.window.close();
    }
}

module.exports = { RelayBrowser };
