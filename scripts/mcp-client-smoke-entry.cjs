const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ApiConfigStore } = require('../electron-main/api-config-store');
const profile = process.env.FLOW_MCP_SMOKE_PROFILE;
if (!profile) throw new Error('Isolated smoke profile required');
app.setPath('userData', profile);
Object.defineProperty(app, 'isPackaged', { value: process.env.FLOW_SOURCE_SMOKE !== '1' });
if (process.env.FLOW_API_CATALOG_SMOKE_ONBOARDING !== '1') {
    fs.mkdirSync(path.join(profile, 'data'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'data/relay-browser.json'), JSON.stringify({ onboardingSkipped: true }));
}
app.whenReady().then(() => {
    new ApiConfigStore(profile, { protect: value => safeStorage.encryptString(value), unprotect: value => safeStorage.decryptString(value) })
        .save({ version: 1, revision: 1, providers: [], globalConfig: {} });
});
require(process.env.FLOW_MCP_SMOKE_ASAR
    ? path.join(process.env.FLOW_MCP_SMOKE_ASAR, 'electron-main/main.js') : '../electron-main/main.js');
