const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createAppUpdates, selectRelease, downloadVerifiedAsset } = require('./app-updates.cjs');

const bytes = Buffer.from('verified installer fixture');
function release(version = '1.6.0-beta.14', extra = {}) {
    return { tag_name: `v${version}`, body: '修复与改进', draft: false, prerelease: version.includes('-'),
        assets: [`Corvas.Setup.${version}.exe`, `Corvas.${version}.exe`, `Corvas.${version}.mac.universal.dmg`, version.includes('-') ? 'beta.yml' : 'latest.yml']
            .map(name => ({ name, size: bytes.length, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` })), ...extra };
}
test('version selection ignores drafts, downgrades, incomplete releases and beta versions for stable users', () => {
    assert.equal(selectRelease([release('1.6.0-beta.15', { draft: true }), release()], '1.6.0-beta.13', 'win32').version, '1.6.0-beta.14');
    assert.equal(selectRelease([release('1.6.0-beta.9')], '1.6.0-beta.13', 'win32'), null);
    assert.equal(selectRelease([release('1.7.0-beta.1')], '1.6.0', 'win32'), null);
    assert.equal(selectRelease([release('1.7.0')], '1.6.0', 'win32').version, '1.7.0');
    assert.equal(selectRelease([release(undefined, { assets: [] })], '1.6.0-beta.13', 'win32'), null);
});
test('NSIS downloads only on command, preserves pending task checks and installs only after download', async () => {
    const native = new EventEmitter(); let downloaded = 0, installed = 0, busy = true;
    native.setFeedURL = feed => assert.match(feed.url, /^https:\/\/github.com\/U-uu-U\/Corvas\/releases\/download\/v1.6.0-beta.14\/$/);
    native.checkForUpdates = async () => ({ updateInfo: { version: '1.6.0-beta.14' }, cancellationToken: { cancel() {} } });
    native.downloadUpdate = async () => { downloaded++; native.emit('download-progress', { percent: 100 }); };
    native.quitAndInstall = () => installed++;
    const updates = createAppUpdates({ currentVersion: '1.6.0-beta.13', platform: 'win32', packaged: true,
        fetchImpl: async () => new Response(JSON.stringify([release()])), updaterFactory: () => native,
        prepareInstall: async () => { if (busy) throw Object.assign(new Error('busy'), { code: 'TASKS_RUNNING' }); } });
    await updates.install(); assert.equal(installed, 0);
    assert.equal((await updates.check()).phase, 'available'); assert.equal(downloaded, 0);
    assert.equal((await updates.download()).phase, 'downloaded'); assert.equal(downloaded, 1);
    assert.equal(native.autoInstallOnAppQuit, false); assert.equal(native.allowDowngrade, false);
    assert.equal((await updates.install()).phase, 'downloaded'); assert.equal(installed, 0);
    busy = false; await updates.install(); assert.equal(installed, 1);
});
test('manual installer download verifies bytes and rejects corrupt data and untrusted redirects', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-updates-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const asset = selectRelease([release()], '1.6.0-beta.13', 'darwin');
    const options = { asset, directory, signal: new AbortController().signal, onProgress() {} };
    const filename = await downloadVerifiedAsset({ ...options, fetchImpl: async () => new Response(bytes) });
    assert.deepEqual(await fs.readFile(filename), bytes);
    await assert.rejects(downloadVerifiedAsset({ ...options, fetchImpl: async () => new Response(Buffer.alloc(bytes.length)) }), /checksum/);
    await assert.rejects(downloadVerifiedAsset({ ...options, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/payload.dmg' } }) }), /Untrusted/);
});
test('source mode can check versions without downloading or installing', async () => {
    const updates = createAppUpdates({ currentVersion: '1.6.0-beta.13', platform: 'win32', packaged: false,
        fetchImpl: async () => new Response(JSON.stringify([release()])), updaterFactory: () => assert.fail('Source may not install') });
    await updates.check(); assert.equal((await updates.download()).mode, 'source');
    assert.equal((await updates.install()).phase, 'available');
});

test('Mac software updates require explicit check download and open actions', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-mac-update-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let requests = 0, opened = 0;
    const updates = createAppUpdates({ currentVersion: '1.6.0-beta.13', platform: 'darwin', packaged: true, directory,
        fetchImpl: async (url, options) => { requests++; assert.equal(options.credentials, 'omit');
            return url.includes('api.github.com') ? new Response(JSON.stringify([release()])) : new Response(bytes); },
        updaterFactory: () => assert.fail('unsigned Mac release must not invoke a silent installer'),
        openInstaller: async filename => { opened++; assert.deepEqual(await fs.readFile(filename), bytes); } });
    assert.equal(requests, 0);
    assert.equal(updates.snapshot().mode, 'manual');
    await updates.install();
    assert.equal(opened, 0);
    assert.equal((await updates.check()).phase, 'available');
    assert.equal(requests, 1);
    assert.equal((await updates.download()).phase, 'downloaded');
    assert.equal(opened, 0);
    await updates.install();
    assert.equal(opened, 1);
});
test('canceling a native download returns to available without offering installation', async () => {
    const native = new EventEmitter(); let rejectDownload;
    native.setFeedURL = () => {};
    native.checkForUpdates = async () => ({ updateInfo: { version: '1.6.0-beta.14' }, cancellationToken: { cancel() { rejectDownload(new Error('Canceled')); } } });
    native.downloadUpdate = () => new Promise((_resolve, reject) => { rejectDownload = reject; });
    const updates = createAppUpdates({ currentVersion: '1.6.0-beta.13', platform: 'win32', packaged: true,
        fetchImpl: async () => new Response(JSON.stringify([release()])), updaterFactory: () => native });
    await updates.check(); const pending = updates.download();
    await new Promise(resolve => setImmediate(resolve)); updates.cancel();
    assert.equal((await pending).phase, 'available');
});
