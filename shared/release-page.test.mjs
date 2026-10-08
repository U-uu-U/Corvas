import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createReleaseServer, parseRange } from '../server/release-page/server.mjs';

async function fixture(t) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-release-http-'));
    const version = '1.6.0-beta.13';
    const directory = path.join(dataDir, 'releases', version);
    await fs.mkdir(directory, { recursive: true });
    const content = Buffer.from('0123456789installer');
    const assets = [];
    for (const [platform, name] of [['windows', `Corvas.Setup.${version}.exe`], ['macos', `Corvas.${version}.mac.universal.dmg`]]) {
        await fs.writeFile(path.join(directory, name), content);
        assets.push({ platform, name, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
    }
    const manifest = { version, sourceCommit: 'a'.repeat(40), publishedAt: '2026-09-29T00:00:00Z', notes: ['<script>bad()</script>'], assets };
    await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(dataDir, 'current.json'), JSON.stringify({ version }));
    const server = createReleaseServer({ dataDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
    return { url: `http://127.0.0.1:${server.address().port}`, directory, assets, content };
}

test('release page and API serve verified asset links and escape notes', async t => {
    const f = await fixture(t);
    const page = await fetch(f.url + '/corvas'); const html = await page.text();
    assert.match(html, /Corvas 画布/); assert.ok(html.includes(f.assets[0].name));
    assert.ok(!html.includes('<script>bad()</script>'));
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const response = await fetch(f.url + '/corvas/api/latest'); const meta = await response.json();
    assert.equal(meta.assets.length, 2); assert.equal(meta.channel, 'beta');
    assert.equal((await fetch(f.url + '/corvas/api/latest', { headers: { 'if-none-match': response.headers.get('etag') } })).status, 304);
    assert.equal((await fetch(f.url + '/corvas', { method: 'POST' })).status, 405);
});
test('installer downloads support Range and HEAD and restrict files to the release manifest', async t => {
    const f = await fixture(t); const url = f.url + '/corvas/releases/1.6.0-beta.13/' + f.assets[0].name;
    const partial = await fetch(url, { headers: { range: 'bytes=2-5' } });
    assert.equal(partial.status, 206); assert.equal(await partial.text(), '2345');
    const tail = await fetch(url, { headers: { range: 'bytes=-3' } }); assert.equal(await tail.text(), 'ler');
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), String(f.content.length)); assert.equal(await head.text(), '');
    assert.equal((await fetch(url, { headers: { range: 'bytes=100-200' } })).status, 416);
    assert.equal((await fetch(f.url + '/corvas/releases/1.6.0-beta.13/release.json')).status, 404);
    await fs.unlink(path.join(f.directory, f.assets[0].name)); assert.equal((await fetch(url)).status, 404);
});
test('range parser rejects multi-ranges, reversals and unsafe integers', () => {
    for (const header of ['bytes=3-1', 'bytes=0-2,4-5', 'bytes=-', 'bytes=-0', 'bytes=99999999999999999999-']) assert.equal(parseRange(header, 10), false);
    assert.deepEqual(parseRange('bytes=0-999', 10), { start: 0, end: 9 });
});
