const { app, BrowserWindow, BrowserView, session, shell, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const profile = process.env.RELAY_SMOKE_PROFILE;
if (!profile || !process.env.RELAY_SMOKE_ART) throw new Error('Isolated relay smoke profile required');
app.setPath('userData', profile);
app.whenReady().then(async () => {
    const { RelayBrowser } = require('../electron-main/relay-browser.cjs');
    const { createRelayImporter } = require('../electron-main/relay-browser-import.cjs');
    const FlowCanvasBridge = require('../electron-main/mcp-bridge.js');
    const { AgentBoardService } = await import('../electron-main/agent-board-service.mjs');
    const { installGenerationRecoveryBoard } = await import('../electron-main/generation-recovery-board.mjs');
    const { mergeRelayAccount } = await import('../src/relay-account-config.js');
    const { ApiConfigStore } = require('../electron-main/api-config-store.js');
    const accounts = new ApiConfigStore(profile, { protect: text => safeStorage.encryptString(text),
        unprotect: bytes => safeStorage.decryptString(bytes) });
    const catalog = { catalogMode: 'remote', models: [{ id: 'fixture', kind: 'video',
        catalog: { model: 'fixture', hosts: ['art.ravenhash.org', 'cart.ravenhash.org'] } },
    { id: 'image-fixture', kind: 'image', catalog: { model: 'image-fixture', hosts: ['ai.ravenhash.org'] } }] };
    const boardFile = path.join(profile, 'board.json');
    const store = { load: () => JSON.parse(fs.readFileSync(boardFile)), save: value => { fs.writeFileSync(boardFile, JSON.stringify(value)); return true; } };
    const board = new AgentBoardService({ store });
    const bridge = new FlowCanvasBridge({ store, recoveryDirectory: path.join(profile, 'recovery') });
    const recoveryStore = bridge.recoveryStore;
    recoveryStore.update('original-task', { kind: 'video', taskId: 'task1', endpoint: 'https://art.ravenhash.org',
        projectId: 'original', nodeId: 'node1', prompt: 'original', model: 'fixture' });
    installGenerationRecoveryBoard(bridge, board);
    global.relayRevealed = [];
    global.relaySmoke = new RelayBrowser({ BrowserWindow, BrowserView, session,
        shell: { ...shell, showItemInFolder: file => global.relayRevealed.push(file) }, directory: profile,
        getLinkedAccount: (site, userId) => accounts.load().config?.providers.find(provider =>
            provider.relayAccount?.site === site && provider.relayAccount?.userId === userId)?.relayAccount,
        onAccount: async account => {
            const config = mergeRelayAccount(accounts.load().config || {}, catalog, account);
            const saved = accounts.save(config);
            if (!saved.success) throw new Error('Fixture account save failed');
        },
        importer: createRelayImporter({ bridge, store, board, getSaveDir: () => path.join(profile, 'videos') }),
        sites: { ai: { name: '生图站', origin: process.env.RELAY_SMOKE_AI, loginPath: '/sign-in' },
            art: { name: '视频站', origin: process.env.RELAY_SMOKE_ART }, cart: { name: '企业站', origin: process.env.RELAY_SMOKE_CART } } });
    global.relayAccountStore = accounts;
    ipcMain.handle('relay-browser:command', (event, action, value) => global.relaySmoke.command(event, action, value));
    await global.relaySmoke.open();
});
app.on('window-all-closed', () => {});
app.on('before-quit', () => global.relaySmoke?.close());
