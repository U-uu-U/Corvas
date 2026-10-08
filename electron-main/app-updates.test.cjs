const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createAppUpdates, selectRelease, downloadVerifiedAsset, describeUpdateError, validateNativeUpdateInfo, UPDATE_ORIGINS } = require('./app-updates.cjs');

const bytes = Buffer.from('verified installer fixture');
function release(version = '1.6.0-beta.14', extra = {}) {
    return { product: 'Corvas', version, sourceCommit: 'a'.repeat(40), notes: ['修复与改进'],
        assets: [['windows', `Corvas.Setup.${version}.exe`], ['windows-portable', `Corvas.${version}.exe`], ['macos', `Corvas.${version}.mac.universal.dmg`]]
            .map(([platform, name]) => ({ platform, name, bytes: bytes.length, url: `/corvas/releases/${version}/${name}`,
                sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sha512: crypto.createHash('sha512').update(bytes).digest('base64') })), ...extra };
}
const catalog = () => new Response(JSON.stringify({ schemaVersion: 1, releases: [release()] }));
function nativeInfo(version = '1.6.0-beta.14') {
    const asset = release(version).assets[0];
    return { version, path: asset.name, sha512: asset.sha512,
        files: [{ url: asset.name, sha512: asset.sha512, size: asset.bytes }] };
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
    native.setFeedURL = feed => assert.equal(feed.url, 'https://cart.ravenhash.org/corvas/releases/1.6.0-beta.14/');
    native.checkForUpdates = async () => ({ updateInfo: nativeInfo(), cancellationToken: { cancel() {} } });
    native.downloadUpdate = async () => { downloaded++; native.emit('download-progress', { percent: 100 }); };
    native.quitAndInstall = () => installed++;
    const updates = createAppUpdates({ currentVersion: '1.6.0-beta.13', platform: 'win32', packaged: true,
        fetchImpl: async () => catalog(), updaterFactory: () => native,
        prepareInstall: async () => { if (busy) throw Object.assign(new Error('busy'), { code: 'TASKS_RUNNING' }); } });
    await updates.install(); assert.equal(installed, 0);
    assert.equal((await updates.check()).phase, 'available'); assert.equal(downloaded, 0);
    assert.equal((await updates.download()).phase, 'downloaded'); assert.equal(downloaded, 1);
    assert.equal(native.autoInstallOnAppQuit, false); assert.equal(native.allowDowngrade, false);
    assert.equal(native.disableDifferentialDownload, true);
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
        fetchImpl: async () => catalog(), updaterFactory: () => assert.fail('Source may not install') });
    await updates.check(); assert.equal((await updates.download()).mode, 'source');
    assert.equal((await updates.install()).phase, 'available');
});

test('Mac software updates require explicit check download and open actions', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-mac-update-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let requests = 0, opened = 0;
    const updates = createAppUpdates({ currentVersion: '1.6.0-beta.13', platform: 'darwin', packaged: true, directory,
        fetchImpl: async (url, options) => { requests++; assert.equal(options.credentials, 'omit');
            assert.ok(UPDATE_ORIGINS.includes(new URL(url).origin));
            return url.endsWith('/api/updates') ? catalog() : new Response(bytes); },
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
    native.checkForUpdates = async () => ({ updateInfo: nativeInfo(), cancellationToken: { cancel() { rejectDownload(new Error('Canceled')); } } });
    native.downloadUpdate = () => new Promise((_resolve, reject) => { rejectDownload = reject; });
    const updates = createAppUpdates({ currentVersion: '1.6.0-beta.13', platform: 'win32', packaged: true,
        fetchImpl: async () => catalog(), updaterFactory: () => native });
    await updates.check(); const pending = updates.download();
    await new Promise(resolve => setImmediate(resolve)); updates.cancel();
    assert.equal((await pending).phase, 'available');
});

test('discovery falls back between owned sites without contacting GitHub or forwarding credentials', async () => {
    const requests = [], diagnostics = [];
    const updates = createAppUpdates({ currentVersion: '1.6.0-beta.13', platform: 'win32', packaged: false,
        onDiagnostic: value => diagnostics.push(value), fetchImpl: async (url, options) => {
            requests.push(url); assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Authorization, undefined);
            return url.startsWith(UPDATE_ORIGINS[0]) ? new Response('', { status: 429 }) : catalog();
        } });
    assert.equal((await updates.check()).phase, 'available');
    assert.deepEqual(requests, UPDATE_ORIGINS.map(origin => origin + '/corvas/api/updates'));
    assert.equal(diagnostics[0].code, 'UPDATE_RATE_LIMITED');
    assert.ok(!JSON.stringify(diagnostics).includes('https://'));
});

test('native metadata cannot redirect installers or replace declared integrity; corrupt metadata never downloads', async () => {
    const asset = selectRelease([release()], '1.6.0-beta.13', 'win32');
    for (const change of [{ version: '1.6.0-beta.99' }, { sha512: 'x'.repeat(88) },
        { files: [{ ...nativeInfo().files[0], url: 'https://evil.test/installer.exe' }] }]) {
        assert.throws(() => validateNativeUpdateInfo({ ...nativeInfo(), ...change }, asset), /does not match/);
    }
    const native = new EventEmitter(); native.setFeedURL = () => {};
    native.checkForUpdates = async () => ({ updateInfo: { ...nativeInfo(), path: '../payload.exe' } });
    native.downloadUpdate = () => assert.fail('Invalid metadata must not download');
    const updates = createAppUpdates({ currentVersion: '1.6.0-beta.13', platform: 'win32', packaged: true,
        fetchImpl: async () => catalog(), updaterFactory: () => native });
    await updates.check(); assert.equal((await updates.download()).errorCode, 'UPDATE_METADATA_INVALID');
});

test('native transient download failure retries only the same verified release on the other owned site', async () => {
    const native = new EventEmitter(); const feeds = []; let attempts = 0;
    native.setFeedURL = feed => feeds.push(feed.url);
    native.checkForUpdates = async () => ({ updateInfo: nativeInfo() });
    native.downloadUpdate = async () => { if (++attempts === 1) throw Object.assign(new Error('server failure'), { statusCode: 503 }); };
    const updates = createAppUpdates({ currentVersion: '1.6.0-beta.13', platform: 'win32', packaged: true,
        fetchImpl: async () => catalog(), updaterFactory: () => native });
    await updates.check(); assert.equal((await updates.download()).phase, 'downloaded');
    assert.deepEqual(feeds, UPDATE_ORIGINS.map(origin => origin + '/corvas/releases/1.6.0-beta.14/'));
});

test('rate limits, network failures, storage failures and checksum failures have distinct safe messages', () => {
    assert.equal(describeUpdateError({ statusCode: 429 }).code, 'UPDATE_RATE_LIMITED');
    assert.equal(describeUpdateError({ code: 'ERR_UPDATER_CHECKSUM_MISMATCH' }).code, 'UPDATE_INTEGRITY_FAILED');
    assert.equal(describeUpdateError({ code: 'ETIMEDOUT' }).code, 'UPDATE_TIMEOUT');
    assert.equal(describeUpdateError({ code: 'ENOSPC' }).code, 'ENOSPC');
    assert.equal(describeUpdateError(new Error('secret raw body')).code, 'UPDATE_NETWORK_FAILED');
    assert.doesNotMatch(describeUpdateError(new Error('secret raw body')).message, /secret/);
});
