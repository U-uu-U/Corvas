const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { ApiConfigStore } = require('../electron-main/api-config-store');
const { RhinoDesktop } = require('../electron-main/rhino-desktop.cjs');

const profile = process.env.FLOW_WORKFLOW_SMOKE_PROFILE;
if (!profile || !fs.existsSync(path.join(profile, 'workflow-smoke.marker'))) {
    throw new Error('An isolated workflow smoke profile is required');
}
app.setPath('userData', profile);
app.setPath('sessionData', profile);
Object.defineProperty(app, 'isPackaged', { value: true });
const executable = path.join(profile, 'Rhino.exe');
RhinoDesktop.prototype.discover = async () => [{ path: executable, name: 'Workflow fixture' }];
RhinoDesktop.prototype.running = async () => [{ path: executable, pid: 123, ready: true }];
RhinoDesktop.prototype.validPath = file => file === executable;
RhinoDesktop.prototype.focus = async () => {};
RhinoDesktop.prototype.launch = async () => { throw new Error('Smoke test must not launch real Rhino'); };
RhinoDesktop.prototype.bootstrap = async () => { throw new Error('Smoke test must not bootstrap real Rhino'); };
require('../electron-main/agent-provider.cjs').callAgentProvider = async () => {
    fs.appendFileSync(path.join(profile, 'unexpected-provider-calls.log'), 'called\n');
    throw new Error('Fixed workflows must not invoke a language model');
};
app.whenReady().then(() => {
    new ApiConfigStore(profile, { protect: value => safeStorage.encryptString(value), unprotect: value => safeStorage.decryptString(value) })
        .save({ version: 1, revision: 1, providers: [], globalConfig: {} });
});
require('../electron-main/main.js');
