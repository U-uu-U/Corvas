const { app, BrowserWindow, ipcMain, session, safeStorage } = require('electron');
const path = require('node:path');
const { ApiConfigStore } = require('../electron-main/api-config-store.js');
const profile = process.env.FLOW_STARTUP_SMOKE_PROFILE;
if (!profile || !path.basename(profile).startsWith('corvas-startup-')) throw new Error('Isolated startup profile required');
app.setPath('userData', profile);
app.getVersion = () => require('../package.json').version;
Object.defineProperty(app, 'isPackaged', { value: process.env.FLOW_STARTUP_SMOKE_MODE === 'packaged' });
global.startupTrace = { started: Date.now(), windows: [], loads: [], ready: [] };
app.on('browser-window-created', (_event, window) => {
    const record = { id: window.id, created: Date.now() };
    global.startupTrace.windows.push(record);
    window.on('show', () => { record.shown = Date.now(); record.url = window.webContents.getURL(); });
    window.webContents.on('did-finish-load', () => { record.loaded = Date.now(); record.url = window.webContents.getURL(); });
});
ipcMain.on('startup:ready', () => global.startupTrace.ready.push(Date.now()));
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, /^(thumb:get|thumb:preview)$/.test(channel) ? async (...args) => {
    const record = { started: Date.now(), channel, mainVisible: args[0].sender.getOwnerBrowserWindow().isVisible(),
        splashVisible: BrowserWindow.getAllWindows().some(window => window.webContents.getURL().includes('splash.html') && window.isVisible()) };
    global.startupTrace.loads.push(record);
    const delay = Number(process.env.FLOW_STARTUP_SMOKE_DELAY) || 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const result = await listener(...args);
    record.finished = Date.now();
    record.success = result?.success;
    record.error = result?.error;
    return result;
} : listener);
app.whenReady().then(() => {
    new ApiConfigStore(profile, { protect: text => safeStorage.encryptString(text), unprotect: bytes => safeStorage.decryptString(bytes) })
        .save({ providers: [], globalConfig: {} });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        callback({ cancel: !details.url.startsWith('http://127.0.0.1:15321/') });
    });
});
require(process.env.FLOW_STARTUP_SMOKE_ASAR
    ? path.join(process.env.FLOW_STARTUP_SMOKE_ASAR, 'electron-main/main.js') : '../electron-main/main.js');
