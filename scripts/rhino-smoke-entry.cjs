const { app, safeStorage } = require('electron');
const { ApiConfigStore } = require('../electron-main/api-config-store');
const { RhinoDesktop } = require('../electron-main/rhino-desktop.cjs');
const path = require('node:path');
const profile = process.env.FLOW_RHINO_SMOKE_PROFILE;
if (!profile) throw new Error('Isolated Rhino smoke profile required');
app.setPath('userData', profile); app.setPath('sessionData', profile);
Object.defineProperty(app, 'isPackaged', { value: true });
const executable = path.join(profile, 'Rhino.exe');
if (process.env.FLOW_RHINO_SMOKE_LIVE !== '1') {
    RhinoDesktop.prototype.discover = async () => [{ path: executable, name: 'Rhino 测试连接' }];
    RhinoDesktop.prototype.running = async () => [{ path: executable, pid: 123 }];
    RhinoDesktop.prototype.validPath = file => file === executable;
    RhinoDesktop.prototype.focus = async () => {};
}
RhinoDesktop.prototype.launch = async () => { throw new Error('Start the live Rhino bridge before running this smoke test'); };
app.whenReady().then(() => {
    new ApiConfigStore(profile, { protect: value => safeStorage.encryptString(value), unprotect: value => safeStorage.decryptString(value) })
        .save({ version: 1, revision: 1, providers: [], globalConfig: {} });
});
require('../electron-main/main.js');
