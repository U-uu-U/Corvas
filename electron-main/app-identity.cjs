const path = require('node:path');

function configureAppIdentity(app, { platform = process.platform } = {}) {
    const appData = app.getPath('appData');
    const userData = app.getPath('userData');
    const sessionData = app.getPath('sessionData');
    // Keep existing projects, credentials and Chromium storage after rebranding.
    // Explicit profiles (including smoke tests) must keep their own directories.
    if (path.resolve(userData) === path.resolve(appData, app.getName())) {
        const legacyData = path.join(appData, 'flow-canvas');
        app.setPath('userData', legacyData);
        if (path.resolve(sessionData) === path.resolve(userData)) app.setPath('sessionData', legacyData);
    }
    if (platform === 'darwin') {
        // Electron 28 selects its Keychain service from app.name before ready.
        // Keep the old encryption identity, then switch the visible app name.
        app.setName('flow-canvas');
        app.once('ready', () => app.setName('Corvas'));
    } else {
        app.setName('Corvas');
    }
}

module.exports = { configureAppIdentity };
