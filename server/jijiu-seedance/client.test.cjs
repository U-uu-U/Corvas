const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const sharp = require('sharp');
let profile;
let fetchFixture;
let Bridge;
const originalLoad = Module._load;
try {
    Module._load = function (name, ...args) {
        return name === 'electron' ? { app: { getPath: () => profile }, net: { fetch: (...args) => fetchFixture(...args) } }
            : originalLoad.call(this, name, ...args);
    };
    Bridge = require('../../electron-main/mcp-bridge.js');
} finally { Module._load = originalLoad; }

test('existing canvas bridge uploads and submits all 50 references with the remote catalog', async () => {
    const { spec, addCatalogModel } = await import('./catalog.mjs');
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../../configserver/seed/model-config.default.json'), 'utf8'));
    seed.catalogGroups = [{ id: spec.group, kind: 'video', label: 'Seedance 2.5 推荐渠道', order: 20, scope: 'catalog' }];
    const config = addCatalogModel(seed);
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-jijiu-'));
    try {
        const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
        bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
        const input = { prompt: 'Fixture', duration: 30, resolution: '720p', ratio: '9:16', targetDir: profile, addToCanvas: false,
            providerConfig: { endpoint: 'https://art.ravenhash.org/v1', model: spec.model, apiKey: 'fixture-only',
                temporaryUploadEndpoint: 'https://jijiu-fixture.test/upload', temporaryUploadToken: 'fixture-only' } };
        for (const [field, count, extension] of [['sourceReferences', 30, 'png'], ['videoReferences', 10, 'mp4'], ['audioReferences', 10, 'mp3']]) {
            input[field] = [];
            for (let index = 0; index < count; index++) {
                const filePath = path.join(profile, `${field}-${index}.${extension}`);
                const bytes = extension === 'png' ? await sharp({ create: { width: 18, height: 32, channels: 3,
                    background: { r: index + 10, g: 30, b: 160 } } }).png().toBuffer() : Buffer.from(`${field}-${index}`);
                fs.writeFileSync(filePath, bytes);
                input[field].push({ filePath });
            }
        }
        const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
        const resultUrl = 'https://newapi.jijiucanvas.com/v1/tasks/jijiu-fixture/artifacts/video/content?access=fixture-ticket';
        let uploads = 0;
        let submissions = 0;
        fetchFixture = async (url, options = {}) => {
            if (url === 'https://jijiu-fixture.test/upload') {
                uploads++;
                return json({ success: true, url: `https://example.com/reference-${uploads}` });
            }
            if (url === resultUrl) {
                assert.ok(!new Headers(options.headers).has('Authorization'));
                return new Response('fixture video', { headers: { 'content-type': 'video/mp4' } });
            }
            assert.equal(new URL(url).hostname, 'art.ravenhash.org');
            if (options.method === 'POST') {
                submissions++;
                assert.equal(url, 'https://art.ravenhash.org/v1/video/generations');
                const body = JSON.parse(options.body);
                assert.equal(body.model, spec.model);
                assert.equal(body.duration, 30);
                assert.deepEqual([body.images.length, body.videos.length, body.audio_urls.length], [30, 10, 10]);
                return json({ id: 'jijiu-fixture', status: 'queued' });
            }
            return json({ id: 'jijiu-fixture', status: 'completed', data: [{ url: resultUrl }] });
        };
        const result = await bridge._generateVideoFromRenderer(input, AbortSignal.timeout(7000), config);
        assert.equal(uploads, 50);
        assert.equal(submissions, 1);
        assert.ok(fs.existsSync(result.filePath));
    } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});
