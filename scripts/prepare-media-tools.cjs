const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');

async function downloadProbe(release, arch, destination) {
    if (fs.existsSync(destination)) return;
    const response = await fetch(`https://github.com/eugeneware/ffmpeg-static/releases/download/${release}/ffprobe-darwin-${arch}.gz`,
        { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`FFprobe download failed: HTTP ${response.status}`);
    const temporary = destination+'.download';
    try {
        await pipeline(Readable.fromWeb(response.body), createGunzip(), fs.createWriteStream(temporary));
        fs.chmodSync(temporary, 0o755);
        execFileSync('lipo', ['-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64', temporary]);
        fs.renameSync(temporary, destination);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

// Package only the tools for the target OS. macOS tools contain both architectures.
module.exports = async function prepareMediaTools(context = {}) {
    const root = path.resolve(__dirname, '..');
    const platform = context.electronPlatformName || process.platform;
    if (platform !== process.platform) throw new Error('Prepare media tools on the target platform');
    const output = path.join(root, 'build', 'media-tools', platform);
    fs.mkdirSync(output, { recursive: true });
    const ffmpegRoot = path.dirname(require.resolve('ffmpeg-static/package.json'));
    const ffprobeRoot = path.dirname(require.resolve('ffprobe-static/package.json'));
    if (platform === 'darwin') {
        const release = require('ffmpeg-static/package.json')['ffmpeg-static']['binary-release-tag'];
        const cache = path.join(root, 'build', 'media-tools', 'darwin-inputs', release);
        fs.mkdirSync(cache, { recursive: true });
        const ffmpegs = [];
        const ffprobes = [];
        for (const arch of ['x64', 'arm64']) {
            const destination = path.join(cache, 'ffmpeg-'+arch);
            execFileSync(process.execPath, [path.join(ffmpegRoot, 'install.js')], { cwd: root, stdio: 'inherit',
                env: { ...process.env, FFMPEG_BIN: destination, npm_config_platform: 'darwin', npm_config_arch: arch,
                    FFMPEG_BINARY_RELEASE: require('ffmpeg-static/package.json')['ffmpeg-static']['binary-release-tag'] } });
            ffmpegs.push(destination);
            const probe = path.join(cache, 'ffprobe-'+arch);
            // ffprobe-static@3.1.0 labels an Intel binary as arm64; use the matching FFmpeg release.
            await downloadProbe(release, arch, probe);
            ffprobes.push(probe);
            for (const suffix of ['LICENSE', 'README']) {
                const notice = destination+'.'+suffix;
                if (fs.existsSync(notice)) fs.copyFileSync(notice, path.join(output, `media-tools-${arch}.${suffix}`));
            }
        }
        execFileSync('lipo', ['-create', ...ffmpegs, '-output', path.join(output, 'ffmpeg')]);
        execFileSync('lipo', ['-create', ...ffprobes, '-output', path.join(output, 'ffprobe')]);
        for (const name of ['ffmpeg', 'ffprobe']) {
            fs.chmodSync(path.join(output, name), 0o755);
            execFileSync('lipo', ['-verify_arch', 'x86_64', 'arm64', path.join(output, name)]);
        }
    } else {
        const suffix = platform === 'win32' ? '.exe' : '';
        fs.copyFileSync(require('ffmpeg-static'), path.join(output, 'ffmpeg'+suffix));
        fs.copyFileSync(require('ffprobe-static').path, path.join(output, 'ffprobe'+suffix));
        for (const name of ['ffmpeg', 'ffprobe']) execFileSync(path.join(output, name+suffix), ['-version'], { windowsHide: true, stdio: 'ignore' });
    }
    for (const [directory, prefix] of [[ffmpegRoot, 'ffmpeg'], [ffprobeRoot, 'ffprobe']]) {
        for (const name of ['LICENSE', 'LICENSE.txt', 'COPYING', 'ffmpeg.LICENSE', 'README.md']) {
            const source = path.join(directory, name);
            if (fs.existsSync(source)) fs.copyFileSync(source, path.join(output, prefix+'-'+name));
        }
    }
};

if (require.main === module) module.exports().catch(error => { console.error(error.message); process.exitCode = 1; });
