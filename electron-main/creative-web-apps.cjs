const PLATFORMS = Object.freeze({
    tripo: { name: 'Tripo', url: 'https://studio.tripo3d.ai/' },
    jimeng: { name: '即梦', url: 'https://jimeng.jianying.com/ai-tool/home' }
});

function isWebUrl(value) {
    try { return ['http:', 'https:'].includes(new URL(value).protocol); }
    catch { return false; }
}

class CreativeWebApps {
    constructor({ BrowserWindow, session, Menu, shell }) {
        Object.assign(this, { BrowserWindow, session, Menu, shell });
        this.windows = new Map();
        this.children = new Set();
    }

    protect(window, preferences) {
        const web = window.webContents;
        web.on('will-attach-webview', event => event.preventDefault());
        for (const eventName of ['will-navigate', 'will-redirect']) {
            web.on(eventName, (event, url) => { if (!isWebUrl(url) && url !== 'about:blank') event.preventDefault(); });
        }
        web.setWindowOpenHandler(({ url }) => isWebUrl(url) || url === 'about:blank'
            ? { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 760, webPreferences: preferences } }
            : { action: 'deny' });
        web.on('did-create-window', child => {
            this.children.add(child);
            child.once('closed', () => this.children.delete(child));
            this.protect(child, preferences);
            window.once('closed', () => { if (!child.isDestroyed()) child.close(); });
        });
    }

    async open(id) {
        if (!Object.hasOwn(PLATFORMS, id)) throw new Error('未知的网页创作平台');
        const platform = PLATFORMS[id];
        const existing = this.windows.get(id);
        if (existing && !existing.isDestroyed()) {
            if (existing.isMinimized()) existing.restore();
            existing.show(); existing.focus();
            return { platform: id, reused: true };
        }
        const preferences = { session: this.session.fromPartition(`persist:corvas-web-${id}`),
            sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };
        const window = new this.BrowserWindow({ width: 1280, height: 880, minWidth: 640, minHeight: 480,
            title: `${platform.name} · Corvas`, show: true, backgroundColor: '#202124', webPreferences: preferences });
        this.windows.set(id, window);
        window.once('closed', () => { if (this.windows.get(id) === window) this.windows.delete(id); });
        this.protect(window, preferences);
        const web = window.webContents;
        const reload = () => { void window.loadURL(platform.url).catch(() => {}); };
        window.setMenu(this.Menu.buildFromTemplate([{ label: platform.name, submenu: [
            { label: '后退', accelerator: 'Alt+Left', click: () => { if (web.canGoBack()) web.goBack(); } },
            { label: '前进', accelerator: 'Alt+Right', click: () => { if (web.canGoForward()) web.goForward(); } },
            { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => web.reload() },
            { label: '返回创作首页', click: reload },
            { type: 'separator' },
            { label: '在默认浏览器打开', click: () => { void this.shell.openExternal(platform.url).catch(() => {}); } },
            { role: 'close', label: '关闭窗口' }
        ] }]));
        try {
            await window.loadURL(platform.url);
        } catch {
            if (!window.isDestroyed()) window.close();
            throw new Error(`${platform.name} 网页打开失败，请检查网络后重试`);
        }
        return { platform: id, reused: false };
    }

    close() {
        for (const window of [...this.children, ...this.windows.values()]) {
            if (!window.isDestroyed()) window.destroy();
        }
        this.children.clear(); this.windows.clear();
    }
}

module.exports = { CreativeWebApps, PLATFORMS };
