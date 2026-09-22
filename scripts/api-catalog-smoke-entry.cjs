const { app, ipcMain, session } = require('electron');

const configUrl = process.env.FLOW_API_CATALOG_SMOKE_URL;
if (!configUrl || new URL(configUrl).hostname !== '127.0.0.1') throw new Error('Local CONFIG fixture required');
globalThis.apiCatalogSmoke = { fetchModelsCalls: 0, blockedRequests: [] };

const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, channel === 'ai:fetchModels' ? () => {
    globalThis.apiCatalogSmoke.fetchModelsCalls++;
    throw new Error('API catalog smoke must never fetch provider models');
} : listener);
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => on(channel, channel === 'model-config:runtime' ? event => {
    const runtimeEvent = {};
    listener(runtimeEvent);
    event.returnValue = { ...runtimeEvent.returnValue, url: configUrl };
} : listener);

app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        const allowed = new URL(details.url).origin === new URL(configUrl).origin;
        if (!allowed) globalThis.apiCatalogSmoke.blockedRequests.push(details.url);
        callback({ cancel: !allowed });
    });
});
require('./mcp-client-smoke-entry.cjs');
