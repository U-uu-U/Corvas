const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { MediaAccessPolicy, collectBoardMediaScope } = require('./media-access.cjs');
const { handleLocalResourceRequest, decodeLocalResourcePath } = require('./local-resource');

async function fixture(t) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-media-access-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const root = await fs.realpath(temp);
    const media = path.join(root, 'media');
    const userData = path.join(root, 'profile');
    const captured = path.join(userData, 'data', 'captured');
    await fs.mkdir(media);
    await fs.mkdir(captured, { recursive: true });
    const file = path.join(media, 'image.png');
    await fs.writeFile(file, '0123456789');
    const policy = new MediaAccessPolicy({ userData, managedRoots: [captured], getScope: () => ({ roots: [media] }) });
    return { root, media, userData, captured, file, policy };
}
const request = (file, headers = {}, method = 'GET') => ({ url: `local-res://${encodeURIComponent(file)}`, headers: new Headers(headers), method });

test('protocol streams authorized media, HEAD and byte ranges without wildcard CORS', async t => {
    const { file, policy } = await fixture(t);
    const get = await handleLocalResourceRequest(request(file, { origin: 'null' }), { accessPolicy: policy });
    assert.equal(get.status, 200); assert.equal(await get.text(), '0123456789');
    assert.equal(get.headers.get('access-control-allow-origin'), 'null');
    assert.match(get.headers.get('content-security-policy'), /sandbox/);
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
    const range = await handleLocalResourceRequest(request(file, { range: 'bytes=2-5' }), { accessPolicy: policy });
    assert.equal(range.status, 206); assert.equal(await range.text(), '2345');
    assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(range.headers.has('access-control-allow-origin'), false);
    const head = await handleLocalResourceRequest(request(file, {}, 'HEAD'), { accessPolicy: policy });
    assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
});

test('protocol rejects untrusted origins, navigation, missing policy and malformed paths', async t => {
    const { file, policy } = await fixture(t);
    for (const headers of [{ origin: 'https://evil.test' }, { 'sec-fetch-dest': 'document' }, { 'sec-fetch-dest': 'iframe' }]) {
        assert.equal((await handleLocalResourceRequest(request(file, headers), { accessPolicy: policy })).status, 403);
    }
    assert.equal((await handleLocalResourceRequest(request(file))).status, 403);
    assert.throws(() => decodeLocalResourcePath('local-res://x%00.png'));
    assert.throws(() => decodeLocalResourcePath('https://x.png'));
});

test('credentials and executable types stay blocked even in a poisoned board or authorized folder', async t => {
    const f = await fixture(t);
    for (const extension of ['json', 'exe', 'bat', 'cmd', 'lnk', 'ps1', 'js', 'html', 'url', 'dll']) {
        const file = path.join(f.media, `blocked.${extension}`); await fs.writeFile(file, 'secret');
        await assert.rejects(f.policy.resolve(file));
        await assert.rejects(f.policy.resolve(file, { purpose: 'open' }));
    }
    const secret = path.join(f.userData, 'secret.png'); await fs.writeFile(secret, 'secret');
    const poisoned = new MediaAccessPolicy({ userData: f.userData, getScope: () => ({ roots: [f.root], files: [secret] }) });
    await assert.rejects(poisoned.resolve(secret), /配置/);
    const captured = path.join(f.captured, 'result.png'); await fs.writeFile(captured, 'media');
    assert.equal((await f.policy.resolve(captured)).filePath, captured);
});

test('folder scopes cannot escape through prefix siblings, traversal or junctions', async t => {
    const f = await fixture(t);
    const sibling = path.join(f.root, 'media-secret'); await fs.mkdir(sibling);
    const secret = path.join(sibling, 'secret.png'); await fs.writeFile(secret, 'private');
    await assert.rejects(f.policy.resolve(secret), /授权/);
    await assert.rejects(f.policy.resolve(path.join(f.media, '..', 'media-secret', 'secret.png')), /授权/);
    const link = path.join(f.media, 'escape');
    await fs.symlink(sibling, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.policy.resolve(path.join(link, 'secret.png')), /授权/);
});

test('old board exact paths and native file grants remain usable without granting parent folders', async t => {
    const f = await fixture(t);
    const single = path.join(f.root, 'single.png'); const other = path.join(f.root, 'other.png');
    await fs.writeFile(single, 'media'); await fs.writeFile(other, 'private');
    const scope = collectBoardMediaScope({ items: [], folderGroups: [{ folders: [], savedItems: [{ resultFilePaths: [single] }] }] });
    const policy = new MediaAccessPolicy({ getScope: () => scope });
    assert.equal((await policy.resolve(single)).filePath, single);
    await assert.rejects(policy.resolve(other), /授权/);
    policy.grant(other);
    assert.equal((await policy.resolve(other)).filePath, other);
    await assert.rejects(policy.resolve('relative.png'));
});

test('native authorization persists independently; later board edits do not grant new files', async t => {
    const f = await fixture(t);
    const other = path.join(f.root, 'private.png'); await fs.writeFile(other, 'private');
    const registryFile = path.join(f.userData, 'data', 'media-access.v1.json');
    const policy = new MediaAccessPolicy({ registryFile, legacyScope: { files: [f.file] } });
    assert.equal((await policy.resolve(f.file)).filePath, f.file);
    const restarted = new MediaAccessPolicy({ registryFile, legacyScope: { files: [other] } });
    await assert.rejects(restarted.resolve(other), /授权/);
    restarted.grant(other);
    assert.equal((await new MediaAccessPolicy({ registryFile }).resolve(other)).filePath, other);
    await fs.writeFile(registryFile, '{broken');
    assert.throws(() => new MediaAccessPolicy({ registryFile, legacyScope: { files: [other] } }), /授权记录/);
});
