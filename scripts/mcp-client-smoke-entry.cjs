const { app, safeStorage } = require('electron');
const { ApiConfigStore } = require('../electron-main/api-config-store');
const profile = process.env.FLOW_MCP_SMOKE_PROFILE;
if (!profile) throw new Error('Isolated smoke profile required');
app.setPath('userData', profile);
Object.defineProperty(app, 'isPackaged', { value: process.env.FLOW_SOURCE_SMOKE !== '1' });
app.whenReady().then(() => {
    new ApiConfigStore(profile, { protect: value => safeStorage.encryptStringAsync(value), unprotect: async value => (await safeStorage.decryptStringAsync(value)).result })
        .save({ version: 1, revision: 1, providers: [], globalConfig: {} });
});
require('../electron-main/main.js');
