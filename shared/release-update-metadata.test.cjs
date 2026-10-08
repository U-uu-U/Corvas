const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { recordReleaseMetadata } = require('../scripts/release-update-metadata.cjs');
const { selectRelease } = require('../electron-main/app-updates.cjs');

test('beta publication aliases builder latest metadata and passes the updater release contract', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-update-metadata-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const version = '1.6.0-beta.16', sourceCommit = 'a'.repeat(40);
    const manifests = {};
    for (const platform of ['windows', 'macos']) {
        const folder = path.join(directory, platform); fs.mkdirSync(folder);
        const suffix = platform === 'macos' ? '-mac.yml' : '.yml';
        const installer = platform === 'macos' ? `Corvas.${version}.mac.universal.dmg` : `Corvas.Setup.${version}.exe`;
        fs.writeFileSync(path.join(folder, installer), 'installer fixture');
        fs.writeFileSync(path.join(folder, 'latest' + suffix), `version: ${version}\npath: ${installer}\n`);
        manifests[platform] = recordReleaseMetadata({ platform, version, sourceCommit, directory: folder });
        assert.ok(manifests[platform].assets.some(asset => asset.name === 'beta' + suffix));
        assert.deepEqual(fs.readFileSync(path.join(folder, 'beta' + suffix)), fs.readFileSync(path.join(folder, 'latest' + suffix)));
    }
    const assets = [...manifests.windows.assets, ...manifests.macos.assets].map(asset => ({
        name: asset.name, size: asset.bytes, digest: `sha256:${asset.sha256}`
    }));
    const { verifyReleaseProvenance } = await import('../scripts/release-provenance.mjs');
    assert.doesNotThrow(() => verifyReleaseProvenance(manifests, new Map(assets.map(asset => [asset.name, asset])), `v${version}`, sourceCommit));
    const ownAssets = Object.entries(manifests).flatMap(([platform, manifest]) => manifest.assets
        .filter(asset => /\.(exe|dmg)$/.test(asset.name)).map(asset => ({
            ...asset, platform, url: `/corvas/releases/${version}/${asset.name}`,
            sha512: crypto.createHash('sha512').update(fs.readFileSync(path.join(directory, platform, asset.name))).digest('base64')
        })));
    assert.equal(selectRelease([{ product: 'Corvas', version, sourceCommit, assets: ownAssets }], '1.6.0-beta.14', 'win32').version, version);
});
