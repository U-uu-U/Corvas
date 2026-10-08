const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relayBrowser', {
    command: (action, value) => ipcRenderer.invoke('relay-browser:command', action, value),
    onState: callback => ipcRenderer.on('relay-browser:state', (_event, state) => callback(state))
});
