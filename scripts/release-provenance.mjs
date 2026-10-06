export function verifyReleaseProvenance(manifests, assets, tag, sha) {
    const version = tag.slice(1);
    const channel = version.includes('-') ? version.slice(version.indexOf('-') + 1).split('.')[0] : 'latest';
    for (const platform of ['windows', 'macos']) {
        const manifest = manifests[platform];
        if (!manifest || manifest.platform !== platform || manifest.version !== version || manifest.sourceCommit !== sha
            || !Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error('Mismatched build provenance');
        const expected = platform === 'windows' ? [`Corvas.Setup.${version}.exe`, `${channel}.yml`] : [`Corvas.${version}.mac.universal.dmg`];
        if (!expected.every(name => manifest.assets.some(asset => asset.name === name))) throw new Error('Installer is not covered by platform provenance');
        for (const asset of manifest.assets) {
            const uploaded = assets.get(asset.name);
            if (!/^[a-f0-9]{64}$/.test(asset.sha256 || '') || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
                || !uploaded || uploaded.size !== asset.bytes || uploaded.digest !== `sha256:${asset.sha256}`) throw new Error('Incomplete or mismatched release asset');
        }
    }
}
