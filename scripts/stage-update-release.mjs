import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { verifyReleaseProvenance } from './release-provenance.mjs';

const tag = process.env.RELEASE_TAG;
const sha = process.env.RELEASE_COMMIT || process.env.GITHUB_SHA;
if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag || '') || !/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Invalid release identity');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let release;
try { release = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,assets'])); }
catch {
    try { gh(['release', 'create', tag, '--verify-tag', '--draft', '--prerelease', '--title', `Corvas ${tag}`, '--generate-notes']); }
    catch { /* The other platform may have created the draft concurrently. */ }
    release = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,assets']));
}
if (!release.isDraft) throw new Error('Refusing to modify an already published release');
const directory = path.resolve('artifact');
const artifacts = fs.readdirSync(directory).filter(name => !name.startsWith('builder-') && /\.(?:exe|dmg|yml|blockmap|json)$/.test(name));
if (!artifacts.length) throw new Error('No artifacts to stage');
gh(['release', 'upload', tag, ...artifacts.map(name => path.join(directory, name)), '--clobber']);
release = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,assets']));
const available = new Map(release.assets.map(asset => [asset.name, asset]));
const manifests = ['build-info-windows.json', 'build-info-macos.json'];
if (!manifests.every(name => available.has(name))) {
    console.log('Draft staged; waiting for the other platform.');
} else {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-release-manifests-'));
    try {
        const provenance = {};
        gh(['release', 'download', tag, '--dir', temporary, ...manifests.flatMap(name => ['--pattern', name])]);
        for (const name of manifests) {
            const manifestBytes = fs.readFileSync(path.join(temporary, name));
            const declared = available.get(name).digest;
            if (declared && declared !== `sha256:${crypto.createHash('sha256').update(manifestBytes).digest('hex')}`) throw new Error('Manifest checksum mismatch');
            const manifest = JSON.parse(manifestBytes);
            provenance[name === 'build-info-windows.json' ? 'windows' : 'macos'] = manifest;
        }
        // Another platform can upload its manifest before finishing the remaining assets.
        // That platform's stage will run verification again once its upload completes.
        if (Object.values(provenance).some(manifest => manifest.assets?.some(asset => !available.has(asset.name)))) {
            console.log('Draft staged; waiting for the other platform assets.');
            process.exitCode = 0;
        } else {
            verifyReleaseProvenance(provenance, available, tag, sha);
            gh(['release', 'edit', tag, '--draft=false', `--prerelease=${tag.includes('-')}`]);
            console.log('Both tested platforms match the tag; release published for online updates.');
        }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
