const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { HunyuanAccounts } = require('./hunyuan-accounts.cjs');

function setup(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-hunyuan-test-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const launches = [], cleared = [];
    const launchBrowser = options => {
        const child = new EventEmitter();
        child.connected = true;
        child.messages = [];
        child.send = (message, callback) => {
            child.messages.push(message); callback?.();
            if (message.type === 'close') setImmediate(() => { child.connected = false; child.emit('close', 0); });
        };
        child.kill = () => { child.connected = false; child.emit('close', 1); };
        launches.push({ ...options, child });
        return child;
    };
    const clearLegacySession = async id => { cleared.push(id); };
    const service = new HunyuanAccounts({ dataDir, launchBrowser, clearLegacySession });
    return { service, dataDir, launches, cleared, launchBrowser };
}

test('account names persist and renaming preserves the browser profile', async t => {
    const { service, dataDir, launches, launchBrowser } = setup(t);
    const account = (await service.save({ name: '设计主账号' })).account;
    service.open({ id: account.id });
    await service.save({ id: account.id, name: '产品设计' });
    assert.deepEqual(launches[0].child.messages.at(-1), { type: 'rename', name: '产品设计' });
    const restored = new HunyuanAccounts({ dataDir, launchBrowser });
    assert.equal(restored.list().accounts[0].name, '产品设计');
    assert.equal(restored.list().accounts[0].windowOpen, false);
    restored.open({ id: account.id });
    assert.equal(launches[1].profileDir, launches[0].profileDir);
    assert.equal(fs.readFileSync(service.file, 'utf8').includes('cookie'), false);
});

test('multiple accounts launch separate browsers with separate profiles and reuse only themselves', async t => {
    const { service, launches } = setup(t);
    const a = (await service.save({ name: 'A' })).account;
    const b = (await service.save({ name: 'B' })).account;
    service.open({ id: a.id }); service.open({ id: b.id }); service.open({ id: a.id });
    assert.equal(launches.length, 2);
    assert.notEqual(launches[0].child, launches[1].child);
    assert.notEqual(launches[0].profileDir, launches[1].profileDir);
    assert.equal(path.basename(launches[0].profileDir), a.id);
    assert.deepEqual(launches[0].child.messages, [{ type: 'focus' }]);
    assert.deepEqual(launches[1].child.messages, []);
    launches[0].child.emit('close', 0);
    service.open({ id: a.id });
    assert.equal(launches[2].profileDir, launches[0].profileDir);
});

test('removing an account closes its browser before clearing only its profile and legacy session', async t => {
    const { service, launches, cleared } = setup(t);
    const a = (await service.save({ name: 'A' })).account;
    const b = (await service.save({ name: 'B' })).account;
    service.open({ id: a.id }); service.open({ id: b.id });
    for (const launch of launches) { fs.mkdirSync(launch.profileDir, { recursive: true }); fs.writeFileSync(path.join(launch.profileDir, 'fixture'), launch.id); }
    await service.remove({ id: a.id });
    assert.equal(launches[0].child.connected, false);
    assert.equal(launches[1].child.connected, true);
    assert.equal(fs.existsSync(launches[0].profileDir), false);
    assert.equal(fs.readFileSync(path.join(launches[1].profileDir, 'fixture'), 'utf8'), b.id);
    assert.deepEqual(cleared, [a.id]);
    assert.throws(() => service.open({ id: a.id }), /不存在/);
});

test('corrupt accounts are preserved and input cannot select arbitrary profiles', async t => {
    const { service, dataDir, launchBrowser } = setup(t);
    fs.writeFileSync(service.file, '{broken');
    const damaged = new HunyuanAccounts({ dataDir, launchBrowser });
    assert.match(damaged.list().error, /读取失败/);
    await assert.rejects(damaged.save({ name: 'A' }), /读取失败/);
    assert.equal(fs.readFileSync(service.file, 'utf8'), '{broken');
    await assert.rejects(service.save({ name: ' ' }), /账号名称/);
    assert.throws(() => service.open({ id: '../../default' }), /不存在/);
});

test('parallel edits are serialized with removal and old process events cannot affect a reopened browser', async t => {
    const { service, launches } = setup(t);
    const a = (await service.save({ name: 'A' })).account;
    service.open({ id: a.id });
    const old = launches[0].child;
    old.emit('message', { type: 'status', status: 'open' });
    assert.equal(service.list().accounts[0].status, 'open');
    old.emit('close', 1);
    assert.equal(service.list().accounts[0].status, 'error');
    service.open({ id: a.id });
    old.emit('message', { type: 'status', status: 'open' });
    assert.equal(service.list().accounts[0].status, 'loading');
    let release;
    service.clearLegacySession = () => new Promise(resolve => { release = resolve; });
    const removing = service.remove({ id: a.id });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => service.open({ id: a.id }), /正在移除/);
    const saving = service.save({ name: 'B' });
    release(); await Promise.all([removing, saving]);
    assert.deepEqual(service.list().accounts.map(account => account.name), ['B']);
});

test('application shutdown waits for all owned browsers and keeps saved accounts', async t => {
    const { service, launches } = setup(t);
    for (const name of ['A', 'B']) service.open({ id: (await service.save({ name })).account.id });
    await service.closeAll();
    assert.ok(launches.every(launch => !launch.child.connected));
    assert.equal(service.list().accounts.length, 2);
    assert.ok(service.list().accounts.every(account => !account.windowOpen));
});
