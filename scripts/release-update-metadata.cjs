const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const platform = process.argv[2];
if (!['windows', 'macos'].includes(platform)) throw new Error('Expected windows or macos');
const version = require('../package.json').version;
const sourceCommit = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new Error('Release commit required');
const directory = path.resolve(__dirname, '../release');
const names = fs.readdirSync(directory).filter(name => !name.startsWith('builder-') && (platform === 'windows'
    ? /\.(?:exe|yml|blockmap)$/.test(name) : /\.(?:dmg|yml|blockmap)$/.test(name)));
if (platform === 'windows' && !names.some(name => name.endsWith('.yml'))) throw new Error('Windows updater metadata missing');
if (!names.includes(platform === 'windows' ? `Corvas.Setup.${version}.exe` : `Corvas.${version}.mac.universal.dmg`)) throw new Error('Installer missing');
const assets = names.map(name => {
    const bytes = fs.readFileSync(path.join(directory, name));
    return { name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(directory, `build-info-${platform}.json`), JSON.stringify({ version, sourceCommit, platform, assets }, null, 2));
console.log(`${platform}: ${assets.length} verified release assets`);
