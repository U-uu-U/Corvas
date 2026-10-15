const { app, session } = require('electron');
const path = require('node:path');
const profile = process.env.FLOW_MCP_SERVER_SMOKE_PROFILE;
if (!profile || !path.basename(profile).startsWith('corvas-mcp-server-')) throw new Error('Isolated MCP server profile required');
app.setPath('userData', profile);
Object.defineProperty(app, 'isPackaged', { value: process.env.FLOW_SOURCE_SMOKE !== '1' });
app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' });
    });
});
require('../electron-main/main.js');
