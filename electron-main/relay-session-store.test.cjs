const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { RelaySessionStore, restoreSessionCookies, restoreSessionStorage } = require('./relay-session-store.cjs');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-session-store-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const safeStorage = { isEncryptionAvailable: () => true,
        encryptString: text => Buffer.from(text.split('').reverse().join('')),
        decryptString: bytes => bytes.toString().split('').reverse().join('') };
    return { directory, safeStorage, store: new RelaySessionStore({ directory, safeStorage }) };
}

test('session cookies and allowlisted storage survive restart encrypted and stay isolated by site and origin', t => {
    const h = fixture(t);
    h.store.save('art', 'https://art.ravenhash.org', { storage: { token: 'private-login-token', user: '{"id":1}', password: 'must-not-save' },
        cookies: [{ name: 'session', value: 'private-cookie', domain: 'art.ravenhash.org', path: '/', hostOnly: true, secure: true }] });
    const raw = fs.readFileSync(h.store.file, 'utf8');
    assert.doesNotMatch(raw, /private-login-token|private-cookie|must-not-save/);
    const reopened = new RelaySessionStore(h);
    assert.equal(reopened.get('art', 'https://art.ravenhash.org').storage.token, 'private-login-token');
    assert.equal(reopened.get('art', 'https://cart.ravenhash.org'), null);
    assert.equal(reopened.get('cart', 'https://cart.ravenhash.org'), null);
    reopened.clear('art');
    assert.equal(new RelaySessionStore(h).get('art', 'https://art.ravenhash.org'), null);
});

test('unavailable encryption never stores plaintext or overwrites an encrypted session', t => {
    const h = fixture(t);
    h.store.save('art', 'https://art.ravenhash.org', { storage: { token: 'private' } });
    const before = fs.readFileSync(h.store.file);
    h.safeStorage.isEncryptionAvailable = () => false;
    assert.throws(() => h.store.save('art', 'https://art.ravenhash.org', { storage: { token: 'changed' } }));
    assert.deepEqual(fs.readFileSync(h.store.file), before);
});

test('cookie restoration skips expired and foreign cookies and never replaces a newer live cookie', async () => {
    const restored = [];
    await restoreSessionCookies({ cookies: {
        get: async () => [{ name: 'newer', domain: 'art.ravenhash.org', path: '/' }],
        set: async cookie => restored.push(cookie)
    } }, { cookies: [
        { name: 'session', value: 'secret', domain: 'art.ravenhash.org', path: '/', hostOnly: true, secure: true, httpOnly: true },
        { name: 'expired', value: 'old', domain: 'art.ravenhash.org', expirationDate: 1 },
        { name: 'foreign', value: 'other', domain: 'example.com' },
        { name: 'newer', value: 'stale', domain: 'art.ravenhash.org', path: '/' }
    ] }, 'https://art.ravenhash.org');
    assert.deepEqual(restored, [{ name: 'session', value: 'secret', path: '/', secure: true, httpOnly: true, url: 'https://art.ravenhash.org/' }]);
});

test('sessionStorage restore is origin scoped and preserves an existing login', async () => {
    const { runInNewContext } = require('node:vm');
    const values = new Map();
    const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
    let origin = 'https://art.ravenhash.org';
    const web = { executeJavaScript: async script => runInNewContext(script, { location: { origin }, sessionStorage: storage, localStorage: storage }) };
    const saved = { storage: { token: 'saved', user: '{}', other: 'ignored' } };
    assert.equal(await restoreSessionStorage(web, saved, origin), true);
    assert.deepEqual([...values.keys()], ['token', 'user']);
    values.set('token', 'newer');
    assert.equal(await restoreSessionStorage(web, saved, origin), false);
    assert.equal(values.get('token'), 'newer');
    values.clear(); origin = 'https://example.com';
    assert.equal(await restoreSessionStorage(web, saved, 'https://art.ravenhash.org'), false);
    assert.equal(values.size, 0);
});

test('closing during an in-flight save captures logout again so an old token cannot be restored', async t => {
    const h = fixture(t);
    const { RelayBrowser } = require('./relay-browser.cjs');
    const origin = 'https://art.ravenhash.org';
    const browser = new RelayBrowser({ directory: h.directory, safeStorage: h.safeStorage });
    let token = 'old-session';
    let unblock, requested;
    const cookieStarted = new Promise(resolve => { requested = resolve; });
    const cookieWait = new Promise(resolve => { unblock = resolve; });
    const session = { flushStorageData() {}, cookies: { get: async () => { requested(); await cookieWait; return []; }, flushStore: async () => {} } };
    const web = { isDestroyed: () => false, getURL: () => origin + '/dashboard', isLoadingMainFrame: () => false, session,
        executeJavaScript: async script => script.startsWith('(()') ? { token, user: '{}' } : token };
    browser.views.set('art', { webContents: web });
    browser.sessions.set('art', { browserSession: session });
    const staleSave = browser.saveSession('art');
    await cookieStarted;
    token = '';
    const closing = browser.flushSessions();
    unblock();
    await staleSave; await closing;
    assert.equal(new RelaySessionStore(h).get('art', origin), null);
});
