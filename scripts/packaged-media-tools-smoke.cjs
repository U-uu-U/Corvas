const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { MediaProcessor, mediaToolPaths } = require('../electron-main/media-processor.cjs');

(async () => {
    const resourcesPath = path.resolve(process.argv[2] || (process.platform === 'darwin'
        ? 'release/mac-universal/Corvas.app/Contents/Resources' : 'release/win-unpacked/resources'));
    const tools = mediaToolPaths({ packaged: true, resourcesPath });
    for (const file of Object.values(tools)) {
        assert.ok(fs.statSync(file).isFile());
        if (process.platform === 'darwin') execFileSync('lipo', [file, '-verify_arch', 'x86_64', 'arm64']);
        execFileSync(file, ['-version'], { windowsHide: true, stdio: 'ignore' });
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-packaged-tools-'));
    const service = new MediaProcessor({ outputDir: path.join(temporary, 'output'), tools });
    try {
        const input = path.join(temporary, 'input.mp4');
        execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=24',
            '-f', 'lavfi', '-i', 'sine=frequency=600', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input], { windowsHide: true });
        const video = await service.convert({ jobId: randomUUID(), filePath: input,
            options: { format: 'mp4', start: 0.25, end: 1.25, keepAudio: true } });
        assert.equal(video.videoCodec, 'h264');
        assert.equal(video.audioCodec, 'aac');
        assert.ok(Math.abs(video.duration - 1) < 0.15);
        const wav = path.join(temporary, 'input.wav');
        execFileSync(tools.ffmpeg, ['-v', 'error', '-i', input, '-vn', '-c:a', 'pcm_s16le', wav], { windowsHide: true });
        const audio = await service.convert({ jobId: randomUUID(), filePath: wav, options: { format: 'mp3', end: 1 } });
        assert.equal(audio.audioCodec, 'mp3');
        console.log(JSON.stringify({ ok: true, platform: process.platform, resourcesPath, video: video.videoCodec, audio: audio.audioCodec }));
    } finally {
        await service.close();
        fs.rmSync(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
