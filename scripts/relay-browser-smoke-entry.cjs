const { app, BrowserWindow, BrowserView, session, shell, ipcMain } = require('electron');
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
        importer: createRelayImporter({ bridge, store, board, getSaveDir: () => path.join(profile, 'videos') }),
        sites: { art: { name: '个人站', origin: process.env.RELAY_SMOKE_ART }, cart: { name: '企业站', origin: process.env.RELAY_SMOKE_CART } } });
    ipcMain.handle('relay-browser:command', (event, action, value) => global.relaySmoke.command(event, action, value));
    await global.relaySmoke.open();
});
app.on('window-all-closed', () => {});
app.on('before-quit', () => global.relaySmoke?.close());
