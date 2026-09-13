const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { configureAppIdentity } = require('./app-identity.cjs');

function fixture(name, userData, sessionData) {
    const appData = path.resolve('profiles');
    const paths = { appData, userData: userData || path.join(appData, name) };
    paths.sessionData = sessionData || paths.userData;
    return Object.assign(new EventEmitter(), {
        getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; },
        getName: () => name, setName: value => { name = value; }
    });
}

test('Corvas uses the legacy data and browser storage directories', () => {
    for (const name of ['corvas', 'Corvas', 'flow-canvas']) {
        const app = fixture(name);
        configureAppIdentity(app, { platform: 'win32' });
        assert.equal(app.getName(), 'Corvas');
        assert.equal(app.getPath('userData'), path.join(app.getPath('appData'), 'flow-canvas'));
        assert.equal(app.getPath('sessionData'), app.getPath('userData'));
    }
});

test('explicit test and custom profiles remain isolated', () => {
    const profile = path.resolve('isolated-profile');
    const app = fixture('corvas', profile);
    configureAppIdentity(app, { platform: 'win32' });
    assert.equal(app.getName(), 'Corvas');
    assert.equal(app.getPath('userData'), profile);
    assert.equal(app.getPath('sessionData'), profile);
});

test('an explicitly configured browser storage directory is preserved', () => {
    const session = path.resolve('custom-session');
    const app = fixture('Corvas', undefined, session);
    configureAppIdentity(app, { platform: 'win32' });
    assert.equal(app.getPath('sessionData'), session);
});

test('macOS keeps the legacy Keychain identity until Electron initializes encryption', () => {
    const app = fixture('corvas');
    configureAppIdentity(app, { platform: 'darwin' });
    assert.equal(app.getName(), 'flow-canvas');
    app.emit('ready');
    assert.equal(app.getName(), 'Corvas');
    assert.equal(app.getPath('userData'), path.join(app.getPath('appData'), 'flow-canvas'));
});
