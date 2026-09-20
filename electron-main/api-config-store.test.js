const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ApiConfigStore } = require('./api-config-store');

function createStore(root) {
    return new ApiConfigStore(root, {
        protect: value => Buffer.from(value, 'utf8').map(byte => byte ^ 0x5a),
        unprotect: value => Buffer.from(value).map(byte => byte ^ 0x5a).toString('utf8'),
        now: () => new Date('2026-08-30T12:00:00.000Z')
    });
}

test('ApiConfigStore encrypts credentials and restores the latest config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-api-config-'));
    try {
        const store = createStore(root);
        const result = store.save({
            revision: 4,
            providers: [{ id: 'image', apiKey: 'secret-value', model: 'gpt-image-2' }],
            globalConfig: { imageProviderId: 'image' }
        });

        assert.equal(result.success, true);
        const raw = fs.readFileSync(path.join(root, 'data', 'api-config.v1.json'), 'utf8');
        assert.equal(raw.includes('secret-value'), false);
        const loaded = store.load();
        assert.equal(loaded.config.providers[0].apiKey, 'secret-value');
        assert.equal(loaded.config.revision, 4);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ApiConfigStore falls back to a rotated backup when the primary is corrupt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-api-config-'));
    try {
        const store = createStore(root);
        store.save({ revision: 1, providers: [{ id: 'first', apiKey: 'one' }] });
        store.save({ revision: 2, providers: [{ id: 'second', apiKey: 'two' }] });
        fs.writeFileSync(path.join(root, 'data', 'api-config.v1.json'), '{broken', 'utf8');

        const loaded = store.load();
        assert.equal(loaded.success, true);
        assert.equal(loaded.recoveredFromBackup, true);
        assert.equal(loaded.config.providers[0].id, 'first');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ApiConfigStore refuses plaintext fallback and leaves the previous credentials untouched', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-api-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const secure = createStore(root);
    secure.save({ revision: 1, providers: [{ apiKey: 'original-secret' }] });
    const original = fs.readFileSync(secure.filePath, 'utf8');
    for (const protect of [null, () => null, () => Buffer.alloc(0)]) {
        const store = new ApiConfigStore(root, { protect });
        const result = store.save({ revision: 2, providers: [{ apiKey: 'new-secret' }] });
        assert.equal(result.success, false); assert.match(result.error, /加密不可用/);
        assert.equal(fs.readFileSync(store.filePath, 'utf8'), original);
    }
    assert.equal(fs.existsSync(secure.backupDir), false);
});

test('legacy plaintext is readable but saves and new backups are encrypted even for unchanged config', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-api-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStore(root);
    fs.mkdirSync(store.dataDir, { recursive: true });
    fs.writeFileSync(store.filePath, JSON.stringify({ format: 'plain-json', payload: JSON.stringify({
        revision: 1, providers: [{ apiKey: 'legacy-secret' }], updatedAt: '2026-01-01T00:00:00Z' }) }));
    const loaded = store.load(); assert.equal(loaded.config.providers[0].apiKey, 'legacy-secret');
    assert.equal(store.save(loaded.config).success, true);
    for (const file of [store.filePath, ...store._backupFiles()]) {
        const raw = fs.readFileSync(file, 'utf8'); assert.equal(raw.includes('legacy-secret'), false);
        assert.equal(JSON.parse(raw).format, 'safe-storage');
    }
});
