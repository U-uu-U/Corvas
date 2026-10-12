const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { MediaProcessor, mediaToolPaths, optionsFor } = require('./media-processor.cjs');

// Avoid retaining fixture file handles in libvips on Windows.
sharp.cache(false);
const tools = mediaToolPaths();
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const token = () => crypto.randomUUID();

test('image processing recognizes actual bytes, creates a real PNG and preserves the source', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-process-image-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'renamed.png');
    fs.writeFileSync(filePath, await sharp({ create: { width: 120, height: 80, channels: 3, background: '#d57554' } }).jpeg().toBuffer());
    const original = digest(filePath);
    const granted = [];
    const service = new MediaProcessor({ outputDir: path.join(root, 'output'), tools, grantFile: file => granted.push(file) });
    const metadata = await service.inspect(filePath);
    assert.equal(metadata.format, 'jpeg');
    const result = await service.convert({ jobId: token(), filePath, options: { format: 'png', width: 60, height: 40 } });
    assert.equal(result.kind, 'image');
    assert.equal(result.format, 'png');
    assert.deepEqual([result.width, result.height], [60, 40]);
    assert.equal(digest(filePath), original);
    assert.ok(granted.includes(result.filePath));
    assert.notEqual(result.filePath, filePath);
    assert.deepEqual(fs.readdirSync(path.join(root, 'output')), [path.basename(result.filePath)]);
});

test('real FFmpeg converts and trims audio/video with compatible codecs', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-process-av-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const audio = path.join(root, 'source.wav');
    const video = path.join(root, 'source.mp4');
    execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000', '-t', '2', audio], { windowsHide: true });
    execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi',
        '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video], { windowsHide: true });
    const service = new MediaProcessor({ outputDir: path.join(root, 'output'), tools });
    const audioHash = digest(audio), videoHash = digest(video);
    const mp3 = await service.convert({ jobId: token(), filePath: audio, options: { format: 'mp3', start: 0.25, end: 1.25, bitrate: 128 } });
    assert.equal(mp3.audioCodec, 'mp3');
    assert.ok(Math.abs(mp3.duration - 1) < 0.1);
    const wave = await service.convert({ jobId: token(), filePath: mp3.filePath, options: { format: 'wav' } });
    assert.equal(wave.audioCodec, 'pcm_s16le');
    const progress = [];
    const mp4 = await service.convert({ jobId: token(), filePath: video,
        options: { format: 'mp4', start: 0.5, end: 1.5, maxEdge: 854, keepAudio: false } }, event => progress.push(event));
    assert.equal(mp4.videoCodec, 'h264');
    assert.equal(mp4.hasAudio, false);
    assert.ok(Math.abs(mp4.duration - 1) < 0.1);
    assert.deepEqual([mp4.width, mp4.height], [640, 360]);
    assert.equal(progress.at(-1).percent, 100);
    assert.equal(digest(audio), audioHash); assert.equal(digest(video), videoHash);
    const saved = fs.readdirSync(path.join(root, 'output'));
    assert.equal(saved.length, 3);
    await assert.rejects(service.convert({ jobId: token(), filePath: audio, options: { format: 'mp3', start: 1, end: 0 } }), /结束时间/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'output')), saved);
});

test('cancellation is owner-scoped, prevents concurrent jobs and removes partial results', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-process-cancel-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.wav');
    execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', source], { windowsHide: true });
    const service = new MediaProcessor({ outputDir: path.join(root, 'output'), tools });
    const jobId = token();
    const work = service.convert({ jobId, filePath: source, options: { format: 'mp3' } }, event => {
        if (event.stage === 'processing') {
            assert.equal(service.cancel(jobId, 'someone-else'), false);
            assert.equal(service.cancel(jobId, 'owner'), true);
        }
    }, 'owner');
    await assert.rejects(service.convert({ jobId: token(), filePath: source }), /已有素材/);
    await assert.rejects(work, error => error.code === 'MEDIA_PROCESS_CANCELED');
    assert.equal(service.active, null);
    assert.deepEqual(fs.readdirSync(path.join(root, 'output')), []);
    assert.ok(fs.existsSync(source));
});

test('invalid options and unapproved inputs fail before conversion', async () => {
    const info = { kind: 'image', width: 10, height: 10 };
    assert.throws(() => optionsFor(info, { width: 16384, height: 16384 }), /像素/);
    assert.throws(() => optionsFor(info, { format: '../../exe' }), /格式/);
    assert.throws(() => optionsFor({ kind: 'audio', duration: 6 }, { end: 7 }), /结束时间/);
    const service = new MediaProcessor({ outputDir: os.tmpdir(), tools, resolveFile: async () => { throw new Error('Not granted'); } });
    await assert.rejects(service.convert({ jobId: token(), filePath: 'C:/private.wav' }), /Not granted/);
});
