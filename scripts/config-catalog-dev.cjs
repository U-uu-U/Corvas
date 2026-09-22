'use strict';

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ApiConfigStore } = require('../electron-main/api-config-store');

const originalProfile = path.join(app.getPath('appData'), 'flow-canvas');
const profile = process.env.FLOW_CONFIG_LAB_PROFILE || path.join(app.getPath('appData'), 'flow-canvas-config-lab');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
if (!fs.existsSync(path.join(profile, 'data', 'api-config.v1.json'))) {
    const localState = path.join(originalProfile, 'Local State');
    if (fs.existsSync(localState)) {
        fs.mkdirSync(profile, { recursive: true });
        // Chromium's encrypted profile key is needed to read this user's existing safeStorage accounts.
        fs.copyFileSync(localState, path.join(profile, 'Local State'));
    }
}
process.env.FLOW_CANVAS_REMOTE_CATALOG = '1';
process.env.FLOW_CANVAS_CONFIG_URL ||= 'https://artconfig.ravenhash.org/config/preview';

app.whenReady().then(() => {
    const protection = { protect: value => safeStorage.encryptString(value), unprotect: value => safeStorage.decryptString(value) };
    const target = new ApiConfigStore(profile, protection);
    const existing = target.load();
    if (!existing.config?.providers?.length) {
        const original = new ApiConfigStore(originalProfile, protection).load();
        if (!original.success || !original.config) throw new Error('API accounts are unavailable');
        // The lab copies encrypted account bindings but starts with no locally listed models.
        const providers = original.config.providers.map(provider => ({ ...provider, model: '', models: [] }));
        const saved = target.save({ ...original.config, providers, revision: 1,
            globalConfig: { ...original.config.globalConfig, videoProviderId: null, imageProviderId: null, textProviderId: null } });
        if (!saved.success) throw new Error(saved.error);
    }
    const boardPath = path.join(profile, 'data', 'board.json');
    if (!fs.existsSync(boardPath)) {
        fs.mkdirSync(path.dirname(boardPath), { recursive: true });
        const items = [{ id: 'catalog-video', kind: 'op', nodeType: 'video',
            x: 120, y: 120, width: 320, height: 180, config: { prompt: '', count: 1 } }];
        fs.writeFileSync(boardPath, JSON.stringify({ version: 1, activeGroupId: 'config-lab', items,
            folderGroups: [{ id: 'config-lab', name: 'CONFIG', savedItems: items, connections: [], folders: [], boardRevision: 0 }],
            mcp: { enabled: true, port: Number(process.env.FLOW_CONFIG_LAB_MCP_PORT || 18766) } }));
    }
    console.log('CONFIG lab uses remote-only catalog; source:', process.env.FLOW_CANVAS_CONFIG_URL);
}).catch(error => { console.error(error.message); app.exit(1); });

require('../electron-main/main.js');
