const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
            ffprobes.push(path.join(ffprobeRoot, 'bin', 'darwin', arch, 'ffprobe'));
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
