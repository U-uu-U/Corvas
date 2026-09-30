const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

function harness(platform) {
    const instances = [];
    const changes = [];
    const exported = { exports: {} };
    runInNewContext(readFileSync(require.resolve('./watcher.js'), 'utf8'), {
        module: exported, process: { platform }, console: { log() {}, warn() {}, error() {} },
        require(name) {
            if (name === 'chokidar') return { watch(folder, options) {
                const watcher = new EventEmitter();
                watcher.closed = new Promise(resolve => { watcher.finishClose = resolve; });
                watcher.close = () => { watcher.closeCalls++; return watcher.closed; };
                Object.assign(watcher, { folder, options, closeCalls: 0 });
                instances.push(watcher);
                return watcher;
            } };
            if (name === 'fs') return { statSync: () => ({ isDirectory: () => true, isFile: () => true, size: 8 }) };
            return require(name);
        }
    });
    return { watcher: new exported.exports({}, (...args) => changes.push(args)), instances, changes };
}

test('macOS uses fs.watch without native fsevents while other platforms retain defaults', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
        const h = harness(platform);
        assert.equal(h.watcher.add('/media'), true);
        assert.equal(h.instances[0].options.useFsEvents, platform === 'darwin' ? false : undefined);
        assert.equal(h.instances[0].options.usePolling, undefined);
    }
});

test('removed watcher events cannot add files to a newly activated group', async () => {
    const h = harness('darwin');
    h.watcher.add('/media');
    const original = h.instances[0];
    original.emit('add', '/media/one.png');
    h.watcher.remove('/media');
    h.watcher.add('/media');
    original.emit('add', '/media/late.png');
    original.emit('unlink', '/media/one.png');
    h.instances[1].emit('add', '/media/two.png');
    assert.deepEqual(h.changes, [['add', '/media/one.png'], ['add', '/media/two.png']]);
    let closed = false;
    const pending = h.watcher.closeAll().then(() => { closed = true; });
    await Promise.resolve();
    assert.ok(h.instances.every(w => w.closeCalls === 1));
    original.finishClose();
    await Promise.resolve();
    assert.equal(closed, false, 'wait for every in-flight close');
    h.instances[1].finishClose();
    await pending;
    assert.equal(closed, true);
    await h.watcher.closeAll();
    assert.ok(h.instances.every(w => w.closeCalls === 1));
});

test('shutdown waits for watchers removed by an earlier group switch', async () => {
    const h = harness('darwin');
    h.watcher.add('/old');
    h.watcher.sync([]);
    let closed = false;
    const pending = h.watcher.closeAll().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    h.instances[0].finishClose();
    await pending;
    assert.equal(h.watcher.pendingCloses.size, 0);
});

test('real watcher delivers a stable new file and finishes closing before folder cleanup', { timeout: 10000 }, async () => {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const os = require('node:os');
    const { once } = require('node:events');
    const Watcher = require('./watcher');
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-watcher-'));
    let resolveAdded;
    const added = new Promise(resolve => { resolveAdded = resolve; });
    const watcher = new Watcher({}, (event, file) => { if (event === 'add') resolveAdded(file); });
    try {
        assert.equal(watcher.add(folder), true);
        await once(watcher.watchers.get(folder), 'ready');
        const file = path.join(folder, 'sample.png');
        await fs.writeFile(file, Buffer.from('fixture'));
        assert.equal(await added, file);
        await watcher.closeAll();
        assert.equal(watcher.pendingCloses.size, 0);
    } finally {
        await watcher.closeAll();
        assert.ok(folder.startsWith(path.join(os.tmpdir(), 'corvas-watcher-')));
        await fs.rm(folder, { recursive: true, force: true });
    }
});
