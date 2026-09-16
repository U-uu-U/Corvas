const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HUNYUAN_URL = 'https://3d.hunyuan.tencent.com/';
const ACCOUNT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const partitionFor = id => {
    if (!ACCOUNT_ID.test(id || '')) throw new Error('混元账号不存在');
    return `persist:corvas-hunyuan-${id}`;
};
const webUrl = value => {
    try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
};

class HunyuanAccounts {
    constructor({ dataDir, BrowserWindow, session, onChange = () => {} }) {
        this.file = path.join(dataDir, 'hunyuan-accounts.json');
        this.BrowserWindow = BrowserWindow;
        this.session = session;
        this.onChange = onChange;
        this.windows = new Map();
        this.states = new Map();
        this.removing = new Set();
        this.queue = Promise.resolve();
        this.accounts = [];
        this.loadError = '';
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > 50) throw new Error('Invalid accounts');
            const seen = new Set();
            this.accounts = data.accounts.map(account => {
                partitionFor(account.id);
                if (seen.has(account.id) || !account.name?.trim()) throw new Error('Invalid account');
                seen.add(account.id);
                return { id: account.id, name: account.name.trim().slice(0, 40),
                    createdAt: account.createdAt, lastOpenedAt: account.lastOpenedAt || null };
            });
        } catch (error) {
            if (error.code !== 'ENOENT') this.loadError = '混元账号配置读取失败，原文件已保留，请重启后重试。';
        }
    }

    list() {
        return { error: this.loadError, accounts: this.accounts.map(account => ({ ...account,
            windowOpen: Boolean(this.windows.get(account.id)?.main),
            status: this.states.get(account.id) || 'closed' })) };
    }

    notify() { this.onChange(this.list()); }

    persist(accounts) {
        if (this.loadError) throw new Error(this.loadError);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, accounts }, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, this.file);
        this.accounts = accounts;
    }

    mutate(callback) {
        const result = this.queue.then(callback);
        this.queue = result.catch(() => {});
        return result;
    }

    account(id) {
        if (this.loadError) throw new Error(this.loadError);
        partitionFor(id);
        const account = this.accounts.find(entry => entry.id === id);
        if (!account) throw new Error('混元账号不存在');
        if (this.removing.has(id)) throw new Error('正在移除该账号，请稍后再试');
        return account;
    }

    save({ id, name } = {}) {
        return this.mutate(() => {
            if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) throw new Error('请输入 1 至 40 个字的账号名称');
            const previous = id ? this.account(id) : null;
            if (!previous && this.accounts.length >= 50) throw new Error('最多可添加 50 个混元账号');
            const account = { ...(previous || { id: crypto.randomUUID(), createdAt: new Date().toISOString(), lastOpenedAt: null }), name: name.trim() };
            this.persist(previous ? this.accounts.map(entry => entry.id === id ? account : entry) : [...this.accounts, account]);
            this.windows.get(id)?.main?.setTitle(`混元 3D · ${account.name}`);
            this.notify();
            return { ...this.list(), account: { ...account } };
        });
    }

    preferences(id) {
        return { session: this.session.fromPartition(partitionFor(id)),
            nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true };
    }

    secureWindow(window, id, group) {
        group.children.add(window);
        const web = window.webContents;
        // Login popups share this account's session, never the canvas preload or another account.
        web.setWindowOpenHandler(({ url }) => webUrl(url) || url === 'about:blank'
            ? { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 760,
                autoHideMenuBar: true, webPreferences: this.preferences(id) } }
            : { action: 'deny' });
        web.on('did-create-window', child => this.secureWindow(child, id, group));
        web.on('will-navigate', (event, url) => { if (!webUrl(url) && url !== 'about:blank') event.preventDefault(); });
        web.on('will-redirect', (event, url) => { if (!webUrl(url) && url !== 'about:blank') event.preventDefault(); });
        web.on('will-attach-webview', event => event.preventDefault());
        window.on('closed', () => group.children.delete(window));
    }

    open({ id } = {}) {
        const account = this.account(id);
        let group = this.windows.get(id);
        if (group?.main && !group.main.isDestroyed()) {
            if (group.main.isMinimized()) group.main.restore();
            group.main.show();
            group.main.focus();
            if (this.states.get(id) === 'error') this.load(group.main, id);
            return this.list();
        }
        this.persist(this.accounts.map(entry => entry.id === id ? { ...entry, lastOpenedAt: new Date().toISOString() } : entry));
        const window = new this.BrowserWindow({ width: 1320, height: 900, minWidth: 840, minHeight: 600,
            title: `混元 3D · ${account.name}`, backgroundColor: '#17181b', autoHideMenuBar: true,
            webPreferences: this.preferences(id) });
        group = { main: window, children: new Set() };
        this.windows.set(id, group);
        this.secureWindow(window, id, group);
        window.on('page-title-updated', event => {
            event.preventDefault();
            window.setTitle(`混元 3D · ${this.accounts.find(entry => entry.id === id)?.name || account.name}`);
        });
        const update = state => {
            if (this.windows.get(id) !== group || this.removing.has(id)) return;
            this.states.set(id, state);
            this.notify();
        };
        window.webContents.on('did-start-loading', () => update('loading'));
        window.webContents.on('did-finish-load', () => update('open'));
        window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
            if (isMainFrame && code !== -3) update('error');
        });
        window.webContents.on('render-process-gone', () => update('error'));
        window.on('closed', () => {
            for (const child of [...group.children]) if (!child.isDestroyed()) child.destroy();
            this.session.fromPartition(partitionFor(id)).flushStorageData();
            this.windows.delete(id);
            this.states.delete(id);
            this.notify();
        });
        this.load(window, id);
        return this.list();
    }

    load(window, id) {
        this.states.set(id, 'loading');
        this.notify();
        window.loadURL(HUNYUAN_URL).catch(error => {
            if (window.isDestroyed() || error.code === 'ERR_ABORTED') return;
            this.states.set(id, 'error');
            this.notify();
        });
    }

    remove({ id } = {}) {
        return this.mutate(async () => {
            this.account(id);
            this.removing.add(id);
            try {
                this.windows.get(id)?.main?.destroy();
                const profile = this.session.fromPartition(partitionFor(id));
                await profile.closeAllConnections();
                await profile.clearStorageData();
                await profile.clearCache();
                profile.flushStorageData();
                this.persist(this.accounts.filter(account => account.id !== id));
                this.states.delete(id);
                this.notify();
                return this.list();
            } finally { this.removing.delete(id); }
        });
    }

    closeAll() {
        for (const { main } of [...this.windows.values()]) if (!main.isDestroyed()) main.destroy();
    }
}

module.exports = { HunyuanAccounts, HUNYUAN_URL, partitionFor };
