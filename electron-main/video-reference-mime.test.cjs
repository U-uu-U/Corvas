const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const sharp = require('sharp');
let profile;
let fetchFixture;
const originalLoad = Module._load;
function loadBridge() {
    try {
        Module._load = function (name, ...args) {
            return name === 'electron' ? { app: { getPath: () => profile }, net: { fetch: (...args) => fetchFixture(...args) } }
                : originalLoad.call(this, name, ...args);
        };
        return require('./mcp-bridge');
    } finally { Module._load = originalLoad; }
}

test('renamed reference images use their actual format and cannot reuse legacy MIME-blind uploads', async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-reference-mime-'));
    try {
        let Bridge = loadBridge();
        let bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
        bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
        const file = path.join(profile, 'renamed.png');
        const bytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#81af98' } }).jpeg().toBuffer();
        fs.writeFileSync(file, bytes);
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const directory = path.join(profile, 'data/reference-cache');
        fs.mkdirSync(directory, { recursive: true });
        const provider = { endpoint: 'https://art.ravenhash.org/v1', model: 'ft-video-v1-b92bdf13b031fea6d7e80431def22584',
            apiKey: 'fixture-only', temporaryUploadEndpoint: 'https://mime-fixture.test/upload', temporaryUploadToken: 'fixture-only' };
        const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
        let uploads = 0;
        let posts = 0;
        fetchFixture = async (url, options = {}) => {
            if (url === provider.temporaryUploadEndpoint) {
                uploads++;
                const form = await new Response(options.body, { headers: options.headers }).formData();
                const image = form.get('file');
                assert.equal(image.type, 'image/jpeg');
                assert.ok(image.name.endsWith('.jpg'));
                assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
                return json({ success: true, url: 'https://mime-fixture.test/reference.jpg' });
            }
            assert.equal(new URL(url).hostname, 'art.ravenhash.org');
            if (url.endsWith('/result.mp4')) return new Response('fixture video');
            if (options.method === 'POST') {
                posts++;
                assert.equal(JSON.parse(options.body).images[0].url, 'https://mime-fixture.test/reference.jpg');
            }
            return json({ id: 'mime-fixture', status: 'completed', video_url: 'https://art.ravenhash.org/result.mp4' });
        };
        const input = { prompt: 'fixture', duration: 6, ratio: '16:9', resolution: '720p', targetDir: profile,
            addToCanvas: false, providerConfig: provider, sourceReferences: [{ filePath: file }] };
        await bridge._generateVideoFromRenderer(input, AbortSignal.timeout(5000));
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'));
        const entryKey = Object.keys(manifest.uploads).find(key => key.endsWith(':image/jpeg:'+hash));
        assert.ok(entryKey, 'Upload cache identity must include its content MIME');
        const legacyKey = entryKey.split(':')[0]+':'+hash;
        const cached = manifest.uploads[entryKey];
        delete manifest.uploads[entryKey];
        manifest.uploads[legacyKey] = { ...cached, url: 'https://mime-fixture.test/wrong-type.png' };
        fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(manifest));
        delete require.cache[require.resolve('./mcp-bridge')];
        Bridge = loadBridge();
        bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
        bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
        await bridge._generateVideoFromRenderer(input, AbortSignal.timeout(5000));
        assert.equal(uploads, 2, 'Legacy MIME-blind uploads must not be reused');
        await bridge._generateVideoFromRenderer(input, AbortSignal.timeout(5000));
        assert.equal(uploads, 2, 'Correctly typed references still reuse their upload');
        assert.equal(posts, 3);
        assert.deepEqual(fs.readFileSync(file), bytes, 'Reference source file must stay unchanged');
    } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});
