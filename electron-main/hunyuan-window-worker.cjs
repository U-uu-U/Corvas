const { app, BrowserWindow, session, net, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { HUNYUAN_URL, partitionFor } = require('./hunyuan-accounts.cjs');
const { HunyuanModelWatcher } = require('./hunyuan-model-watcher.cjs');

const argument = key => process.argv[process.argv.indexOf(key) + 1];
const id = argument('--account-id');
partitionFor(id);
let name = String(argument('--account-name') || '混元账号').slice(0, 40);
const profileDir = argument('--account-profile');
if (!profileDir || !path.isAbsolute(profileDir) || path.basename(profileDir) !== id || !process.send) {
    throw new Error('Invalid isolated browser launch');
}
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
app.setPath('sessionData', profileDir);
app.setName('Corvas Hunyuan');
if (process.platform === 'win32') app.setAppUserModelId(`org.ravenhash.corvas.hunyuan.${id}`);
app.commandLine.appendSwitch('disable-http2');
const smoke = Boolean(process.env.FLOW_HUNYUAN_SMOKE_PROFILE);
if (smoke) app.commandLine.appendSwitch('remote-debugging-port', '0');
const notify = status => { if (process.connected) process.send({ type: 'status', status }); };
let mainWindow;
let failed = false;
let quitting = false;
let modelWatcher;
let workflowState = { mode: 'ask', jobs: [] };
let watchError = '';
const windows = new Set();
const webUrl = value => {
    try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};
const preferences = () => ({ session: session.defaultSession,
    sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });

function updateWorkflowBanner() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hunyuan:workflow-state', { ...workflowState, error: watchError || workflowState.error });
}
const validStudioSender = event => mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame && event.senderFrame.url.startsWith('https://3d.hunyuan.tencent.com/');
ipcMain.on('hunyuan:workflow-ready', event => { if (validStudioSender(event)) updateWorkflowBanner(); });
ipcMain.on('hunyuan:workflow-action', (event, action) => {
    if (validStudioSender(event) && ['confirm', 'dismiss'].includes(action?.action) && typeof action.id === 'string' && process.connected) {
        process.send({ type: 'workflow-action', ...action });
    }
});

function secureWindow(window) {
    windows.add(window);
    const web = window.webContents;
    web.setWindowOpenHandler(({ url }) => webUrl(url) || url === 'about:blank'
        ? { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 760,
            autoHideMenuBar: true, webPreferences: preferences() } }
        : { action: 'deny' });
    web.on('did-create-window', secureWindow);
    for (const eventName of ['will-navigate', 'will-redirect']) web.on(eventName, (event, url) => {
        if (!webUrl(url) && url !== 'about:blank') event.preventDefault();
    });
    web.on('will-attach-webview', event => event.preventDefault());
    window.on('closed', () => windows.delete(window));
}

function load() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    failed = false;
    notify('loading');
    mainWindow.loadURL(HUNYUAN_URL).catch(error => {
        if (quitting || mainWindow.isDestroyed() || error.code === 'ERR_ABORTED') return;
        failed = true; notify('error');
    });
}

function focus() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    // Account browsers live in separate processes; raise the native window as well
    // as focusing it so a click in the canvas brings it to the foreground on Windows.
    const raise = process.platform === 'win32' && !mainWindow.isAlwaysOnTop();
    if (raise) mainWindow.setAlwaysOnTop(true);
    mainWindow.show(); mainWindow.moveTop(); mainWindow.focus();
    mainWindow.webContents.focus();
    if (raise) mainWindow.setAlwaysOnTop(false);
    const current = mainWindow.webContents.getURL();
    // Preserve in-page work (including query/hash state) when geometry is already
    // open. An empty URL belongs to the initial navigation, which is still loading.
    const atGeometry = current && new URL(current).origin === new URL(HUNYUAN_URL).origin
        && new URL(current).pathname.replace(/\/$/, '') === '/studio/creation/geo';
    if (failed || (current && current !== 'about:blank' && !atGeometry)) load();
}

async function close() {
    if (quitting) return;
    quitting = true;
    modelWatcher?.close();
    for (const window of [...windows]) if (!window.isDestroyed()) window.destroy();
    try { await session.defaultSession.cookies.flushStore(); session.defaultSession.flushStorageData(); }
    finally { app.quit(); }
}

process.on('message', message => {
    if (message?.type === 'focus') focus();
    if (message?.type === 'rename') {
        name = String(message.name || name).slice(0, 40);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`混元 3D · ${name}`);
    }
    if (message?.type === 'close') void close();
    if (message?.type === 'workflow-state') { workflowState = message.state; updateWorkflowBanner(); }
    if (message?.type === 'download-model' && typeof message.worksId === 'string') {
        void Promise.resolve().then(() => {
            if (!modelWatcher) throw new Error('混元窗口尚未就绪');
            return modelWatcher.download(message.worksId);
        }).then(filePath => {
            if (process.connected) process.send({ type: 'model-downloaded', requestId: message.requestId, filePath });
        }).catch(() => {
            if (process.connected) process.send({ type: 'model-downloaded', requestId: message.requestId,
                error: '模型下载未完成，请保持混元窗口登录并稍后重试' });
        });
    }
});
process.on('disconnect', () => { if (app.isReady()) void close(); else app.quit(); });
app.on('window-all-closed', () => { if (!quitting) void close(); });
app.on('before-quit', event => {
    if (!quitting && app.isReady()) { event.preventDefault(); void close(); }
});
app.whenReady().then(async () => {
    if (smoke && process.env.FLOW_HUNYUAN_SMOKE_LIVE !== '1') {
        await session.defaultSession.protocol.handle('https', () => new Response(
            '<!doctype html><title>Hunyuan session fixture</title><h1>Independent account fixture</h1><a href="https://xui.ptlogin2.qq.com/" target="TencentLogin">Login popup</a>',
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
        ));
    }
    mainWindow = new BrowserWindow({ width: 1320, height: 900, minWidth: 840, minHeight: 600, show: false,
        title: `混元 3D · ${name}`, backgroundColor: '#17181b', autoHideMenuBar: true,
        icon: path.join(__dirname, 'assets/app-icon.png'), webPreferences: { ...preferences(),
            preload: path.join(__dirname, 'hunyuan-studio-preload.cjs') } });
    secureWindow(mainWindow);
    mainWindow.on('page-title-updated', event => { event.preventDefault(); mainWindow.setTitle(`混元 3D · ${name}`); });
    mainWindow.webContents.on('did-start-loading', () => { failed = false; notify('loading'); });
    mainWindow.webContents.on('did-finish-load', () => { if (!failed) notify('open'); });
    mainWindow.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) { failed = true; notify('error'); }
    });
    mainWindow.webContents.on('render-process-gone', () => { failed = true; notify('error'); });
    mainWindow.on('closed', () => { if (!quitting) void close(); });
    if (!smoke) {
        modelWatcher = new HunyuanModelWatcher({ directory: profileDir, fetch: (...args) => net.fetch(...args),
            canPoll: () => !mainWindow.isDestroyed() && mainWindow.webContents.getURL().startsWith('https://3d.hunyuan.tencent.com/studio/'),
            onTask: task => { if (process.connected) process.send({ type: 'model-task', task }); },
            onError: message => { if (watchError !== message) { watchError = message; updateWorkflowBanner(); } } });
        modelWatcher.start();
    }
    load();
    focus();
}).catch(() => { notify('error'); app.exit(1); });
