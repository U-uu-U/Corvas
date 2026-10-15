const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const sharp = require('sharp');
let profile, fetchFixture, Bridge;
const originalLoad = Module._load;
try {
    Module._load = function (name, ...args) {
        return name === 'electron' ? { app: { getPath: () => profile }, net: { fetch: (...args) => fetchFixture(...args) } }
            : originalLoad.call(this, name, ...args);
    };
    Bridge = require('../../electron-main/mcp-bridge.js');
} finally { Module._load = originalLoad; }

test('existing client submits 30 images and 21:9 through the remote catalog without a client patch', async () => {
    const { model, hosts, addCatalogModel } = await import('./catalog.mjs');
    const { createValidator } = await import('../../configserver/lib/validate.mjs');
    const config = addCatalogModel({ schemaVersion: 1, catalogMode: 'remote',
        catalogScope: { hosts, kinds: ['video'] },
        catalogGroups: [{ id: 'existing', kind: 'video', label: 'Seedance 2.5', order: 20, scope: 'catalog' }],
        models: [{ id: 'peer', kind: 'video', match: { model: ['^seedance-2\\.5-super$'] },
            catalog: { model: 'seedance-2.5-super', hosts, enabled: false }, presentation: { routeGroup: 'existing' } }] });
    const validator = await createValidator({ schemaPath: path.join(__dirname, '../../configserver/schema/model-config.schema.json') });
    const valid = validator.validate(config);
    assert.equal(valid.ok, true, valid.errors.join('; '));
    assert.equal(config.models[0].catalog.enabled, false);
    assert.equal(config.models.at(-1).presentation.routeGroup, 'existing');
    assert.throws(() => addCatalogModel(config), /already exists/);
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-yihong-cheap-'));
    try {
        const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
        bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
        const sourceReferences = [];
        for (let i = 0; i < 30; i++) {
            const filePath = path.join(profile, i+'.png');
            await sharp({ create: { width: 30, height: 20, channels: 3, background: { r: i, g: 70, b: 90 } } }).png().toFile(filePath);
            sourceReferences.push({ filePath });
        }
        const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
        let uploads = 0, submissions = 0;
        const resultUrl = 'https://art.ravenhash.org/fc-media/files/fixture.mp4';
        fetchFixture = async (url, options = {}) => {
            if (url === 'https://fixture.test/upload') return json({ success: true, url: `https://example.com/${++uploads}.png` });
            if (url === resultUrl) {
                assert.equal(new Headers(options.headers).has('Authorization'), false);
                return new Response('fixture video', { headers: { 'content-type': 'video/mp4' } });
            }
            assert.equal(new URL(url).hostname, 'art.ravenhash.org');
            if (options.method === 'POST') {
                submissions++;
                assert.equal(url, 'https://art.ravenhash.org/v1/video/generations');
                const body = JSON.parse(options.body);
                assert.equal(body.model, model);
                assert.equal(body.duration, 30);
                assert.equal(body.ratio, '21:9');
                assert.equal(body.images.length, 30);
                return json({ id: 'cheap_fixture', status: 'queued' });
            }
            return json({ id: 'cheap_fixture', status: 'completed', video_url: resultUrl });
        };
        const input = { prompt: 'Fixture', duration: 30, resolution: '720p', ratio: '21:9', targetDir: profile,
            addToCanvas: false, sourceReferences, providerConfig: { endpoint: 'https://art.ravenhash.org/v1', model,
                apiKey: 'fixture-only', temporaryUploadEndpoint: 'https://fixture.test/upload', temporaryUploadToken: 'fixture-only' } };
        const result = await bridge._generateVideoFromRenderer(input, AbortSignal.timeout(7000), config);
        assert.equal(uploads, 30); assert.equal(submissions, 1); assert.ok(fs.existsSync(result.filePath));
    } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});
