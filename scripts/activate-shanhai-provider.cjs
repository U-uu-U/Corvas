'use strict';

const { app, safeStorage } = require('electron');
const { ApiConfigStore } = require('../electron-main/api-config-store');

const USER_DATA = 'C:/Users/19636/AppData/Roaming/flow-canvas';
const ENDPOINT = 'https://shanhai.vnshu.cn/api/v1';
const MODELS = ['oc-model-qbdmeb', 'oc-model-1iq31f', 'oc-model-bkb50q', 'oc-model-c6ws7e'];
let stdinKey = '';
const stdinKeyPromise = new Promise(resolve => {
    process.stdin.once('data', chunk => { stdinKey = String(chunk).trim(); resolve(stdinKey); });
});

function normalizeEndpoint(value) {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

app.setPath('userData', USER_DATA);
app.whenReady().then(async () => {
    const key = String(process.env.FLOW_CANVAS_SHANHAI_KEY_TASK || stdinKey || await stdinKeyPromise).trim();
    if (!key) throw new Error('Missing Shanhai key');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable');
    const store = new ApiConfigStore(USER_DATA, {
        protect: value => safeStorage.encryptString(value),
        unprotect: value => safeStorage.decryptString(value)
    });
    const loaded = store.load();
    const current = loaded.config || { version: 1, revision: 0, providers: [], globalConfig: {} };
    const providers = Array.isArray(current.providers) ? current.providers.map(provider => ({ ...provider })) : [];
    const index = providers.findIndex(provider => normalizeEndpoint(provider.endpoint) === normalizeEndpoint(ENDPOINT)
        || String(provider.name || '').trim().toLowerCase() === 'shanhai video');
    const previous = index >= 0 ? providers[index] : {};
    const provider = {
        ...previous,
        id: previous.id || 'shanhai-video',
        name: 'Shanhai Video',
        type: previous.type || 'openai',
        capability: 'video',
        endpoint: ENDPOINT,
        model: MODELS[0],
        models: MODELS,
        apiKey: key
    };
    if (index >= 0) providers[index] = provider;
    else providers.push(provider);
    const result = store.save({ ...current, revision: Math.max(0, Number(current.revision) || 0) + 1,
        updatedAt: new Date().toISOString(), providers });
    if (!result.success) throw new Error(result.error || 'Failed to save API configuration');
    process.stdout.write(JSON.stringify({ success: true, action: index >= 0 ? 'updated' : 'added', providerId: provider.id,
        modelCount: MODELS.length, providerCount: providers.length }));
    app.exit(0);
}).catch(error => {
    console.error(JSON.stringify({ success: false, error: error.message }));
    app.exit(1);
});
