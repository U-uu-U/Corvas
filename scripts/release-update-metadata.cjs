const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { updateChannel } = require('../electron-main/app-updates.cjs');

function recordReleaseMetadata({ platform, version, sourceCommit, directory }) {
if (!['windows', 'macos'].includes(platform)) throw new Error('Expected windows or macos');
if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new Error('Release commit required');
const suffix = platform === 'macos' ? '-mac.yml' : '.yml';
const channelFile = updateChannel(version) + suffix;
// GitHub publishing defaults to latest.yml even for beta versions. Our generic
// update feed explicitly asks for beta.yml, so retain an identical channel alias.
if (!fs.existsSync(path.join(directory, channelFile))) {
    const builderMetadata = path.join(directory, 'latest' + suffix);
    if (!fs.existsSync(builderMetadata)) throw new Error('Updater metadata missing');
    fs.copyFileSync(builderMetadata, path.join(directory, channelFile));
}
const names = fs.readdirSync(directory).filter(name => !name.startsWith('builder-') && (platform === 'windows'
    ? /\.(?:exe|yml|blockmap)$/.test(name) : /\.(?:dmg|yml|blockmap)$/.test(name)));
if (!names.includes(channelFile)) throw new Error('Channel updater metadata missing');
if (!names.includes(platform === 'windows' ? `Corvas.Setup.${version}.exe` : `Corvas.${version}.mac.universal.dmg`)) throw new Error('Installer missing');
const assets = names.map(name => {
    const bytes = fs.readFileSync(path.join(directory, name));
    return { name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
const manifest = { version, sourceCommit, platform, assets };
fs.writeFileSync(path.join(directory, `build-info-${platform}.json`), JSON.stringify(manifest, null, 2));
console.log(`${platform}: ${assets.length} verified release assets`);
return manifest;
}

if (require.main === module) recordReleaseMetadata({ platform: process.argv[2], version: require('../package.json').version,
    sourceCommit: process.env.GITHUB_SHA, directory: path.resolve(__dirname, '../release') });
module.exports = { recordReleaseMetadata };
