import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyReleaseProvenance } from '../scripts/release-provenance.mjs';

test('online update publication requires matching platform commits and hashes for both installers and Windows metadata', () => {
    const sourceCommit = 'a'.repeat(40), sha256 = 'b'.repeat(64), version = '1.6.0-beta.14';
    const windows = { platform: 'windows', version, sourceCommit, assets: [`Corvas.Setup.${version}.exe`, 'beta.yml'].map(name => ({ name, bytes: 12, sha256 })) };
    const macos = { platform: 'macos', version, sourceCommit, assets: [{ name: `Corvas.${version}.mac.universal.dmg`, bytes: 12, sha256 }] };
    const assets = new Map([...windows.assets, ...macos.assets].map(asset => [asset.name, { size: asset.bytes, digest: `sha256:${sha256}` }]));
    assert.doesNotThrow(() => verifyReleaseProvenance({ windows, macos }, assets, `v${version}`, sourceCommit));
    assert.throws(() => verifyReleaseProvenance({ windows }, assets, `v${version}`, sourceCommit));
    assert.throws(() => verifyReleaseProvenance({ windows, macos: { ...macos, sourceCommit: 'c'.repeat(40) } }, assets, `v${version}`, sourceCommit));
    assert.throws(() => verifyReleaseProvenance({ windows: { ...windows, assets: windows.assets.slice(0, 1) }, macos }, assets, `v${version}`, sourceCommit));
    assets.set(windows.assets[0].name, { size: 12, digest: 'sha256:' + 'd'.repeat(64) });
    assert.throws(() => verifyReleaseProvenance({ windows, macos }, assets, `v${version}`, sourceCommit));
});
