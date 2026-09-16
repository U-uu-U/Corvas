const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { HunyuanAccounts, HUNYUAN_URL, partitionFor } = require('./hunyuan-accounts.cjs');

function setup(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-hunyuan-test-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const sessions = new Map();
    const windows = [];
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super(); this.options = options; this.webContents = new EventEmitter();
            this.webContents.setWindowOpenHandler = handler => { this.popup = handler; };
            windows.push(this);
        }
        isDestroyed() { return Boolean(this.destroyed); }
        isMinimized() { return false; }
        destroy() { this.destroyed = true; this.emit('closed'); }
        show() { this.shown = true; }
        focus() { this.focused = true; }
        setTitle(title) { this.title = title; }
        async loadURL(url) { this.url = url; }
    }
    const session = { fromPartition(key) {
        if (!sessions.has(key)) sessions.set(key, { key, cleared: false, cacheCleared: false,
            closeAllConnections: async () => {}, clearStorageData: async () => { sessions.get(key).cleared = true; },
            clearCache: async () => { sessions.get(key).cacheCleared = true; }, flushStorageData() {} });
        return sessions.get(key);
    } };
    const service = new HunyuanAccounts({ dataDir, BrowserWindow, session });
    return { service, dataDir, windows, sessions, BrowserWindow, session };
}

test('account names persist and renaming does not replace the login partition', async t => {
    const { service, dataDir, BrowserWindow, session } = setup(t);
    const account = (await service.save({ name: '设计主账号' })).account;
    const partition = partitionFor(account.id);
    service.open({ id: account.id });
    await service.save({ id: account.id, name: '产品设计' });
    const restored = new HunyuanAccounts({ dataDir, BrowserWindow, session });
    assert.equal(restored.list().accounts[0].name, '产品设计');
    assert.equal(partitionFor(restored.list().accounts[0].id), partition);
    assert.ok(restored.list().accounts[0].lastOpenedAt);
    assert.equal(restored.list().accounts[0].windowOpen, false);
    assert.equal(fs.readFileSync(service.file, 'utf8').includes('cookie'), false);
});

test('multiple accounts open independent sessions and one account reuses its window', async t => {
    const { service, windows } = setup(t);
    const a = (await service.save({ name: 'A' })).account;
    const b = (await service.save({ name: 'B' })).account;
    service.open({ id: a.id }); service.open({ id: b.id }); service.open({ id: a.id });
    assert.equal(windows.length, 2);
    assert.notEqual(windows[0].options.webPreferences.session, windows[1].options.webPreferences.session);
    assert.equal(windows[0].focused, true);
    assert.equal(windows[0].url, HUNYUAN_URL);
    assert.equal(windows[0].options.webPreferences.preload, undefined);
    assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
    assert.equal(windows[0].options.webPreferences.sandbox, true);
    windows[0].destroy();
    service.open({ id: a.id });
    assert.equal(windows[2].options.webPreferences.session, windows[0].options.webPreferences.session);
});

test('authentication popups retain account isolation and privileged navigation is blocked', async t => {
    const { service, windows, BrowserWindow } = setup(t);
    const a = (await service.save({ name: 'A' })).account;
    service.open({ id: a.id });
    const main = windows[0];
    const login = main.popup({ url: 'https://xui.ptlogin2.qq.com/' });
    assert.equal(login.action, 'allow');
    assert.equal(login.overrideBrowserWindowOptions.webPreferences.session, main.options.webPreferences.session);
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'local-res://test', 'corvas://admin']) {
        assert.equal(main.popup({ url }).action, 'deny');
        let prevented = false;
        main.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, url);
        assert.equal(prevented, true);
    }
    const popup = new BrowserWindow(login.overrideBrowserWindowOptions);
    main.webContents.emit('did-create-window', popup);
    main.destroy();
    assert.equal(popup.isDestroyed(), true);
});

test('removing an account clears only its login session and closes only its windows', async t => {
    const { service, windows, sessions } = setup(t);
    const a = (await service.save({ name: 'A' })).account;
    const b = (await service.save({ name: 'B' })).account;
    service.open({ id: a.id }); service.open({ id: b.id });
    await service.remove({ id: a.id });
    assert.equal(windows[0].isDestroyed(), true);
    assert.equal(windows[1].isDestroyed(), false);
    assert.equal(sessions.get(partitionFor(a.id)).cleared, true);
    assert.equal(sessions.get(partitionFor(a.id)).cacheCleared, true);
    assert.equal(sessions.get(partitionFor(b.id)).cleared, false);
    assert.deepEqual(service.list().accounts.map(account => account.id), [b.id]);
    assert.throws(() => service.open({ id: a.id }), /不存在/);
});

test('corrupt accounts are preserved and input cannot select arbitrary partitions', async t => {
    const { service, dataDir, BrowserWindow, session } = setup(t);
    fs.writeFileSync(service.file, '{broken');
    const damaged = new HunyuanAccounts({ dataDir, BrowserWindow, session });
    assert.match(damaged.list().error, /读取失败/);
    await assert.rejects(damaged.save({ name: 'A' }), /读取失败/);
    assert.equal(fs.readFileSync(service.file, 'utf8'), '{broken');
    await assert.rejects(service.save({ name: ' ' }), /账号名称/);
    await assert.rejects(service.save({ name: 'a'.repeat(41) }), /账号名称/);
    assert.throws(() => service.open({ id: '../../default' }), /不存在/);
});

test('parallel edits are serialized with removal and failed loads can be retried', async t => {
    const { service, windows, sessions } = setup(t);
    const a = (await service.save({ name: 'A' })).account;
    service.open({ id: a.id });
    windows[0].webContents.emit('did-fail-load', {}, -105, 'offline', HUNYUAN_URL, true);
    assert.equal(service.list().accounts[0].status, 'error');
    service.open({ id: a.id });
    assert.equal(service.list().accounts[0].status, 'loading');
    let release;
    sessions.get(partitionFor(a.id)).clearStorageData = () => new Promise(resolve => { release = resolve; });
    const removing = service.remove({ id: a.id });
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => service.open({ id: a.id }), /正在移除/);
    const saving = service.save({ name: 'B' });
    release();
    await Promise.all([removing, saving]);
    assert.deepEqual(service.list().accounts.map(account => account.name), ['B']);
});
