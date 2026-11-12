const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MESHY, createMeshyProvider, buildMeshyTextBody, buildMeshyRefineBody, buildMeshyImageBody, buildMeshyMultiviewBody,
    meshyStatus } = require('./meshy-3d.cjs');
const { normalizeModel3dRequest } = require('./model3d-common.cjs');
const { generateModel3d, resumeModel3d } = require('./model3d-providers.cjs');

const KEY = 'msy_test_secret_key';
const BASE = 'https://api.meshy.ai/openapi';
const AUTH = { Authorization: `Bearer ${KEY}` };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
const dataUri = (mime, buffer) => `data:${mime};base64,${buffer.toString('base64')}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshy-3d-'));
const file = (name, bytes) => { const target = path.join(dir, name); fs.writeFileSync(target, bytes); return target; };
const pngFile = file('front.png', PNG);
const jpegFile = file('left.jpg', JPEG);
const webpFile = file('back.webp', WEBP);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const response = (status, body, headers = {}) => ({ status, headers: new Headers(headers),
    text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)) });
const accepted = id => response(202, { result: id });
const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
const dropped = code => () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); };

// Records every request and answers from the script. An unscripted request fails the test.
function fake(...script) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
        const next = script.shift();
        if (next === undefined) throw new Error(`unscripted request: ${init.method} ${url}`);
        return typeof next === 'function' ? next(url, init) : next;
    };
    return { calls, provider: createMeshyProvider({ apiKey: KEY, fetchImpl }) };
}

const normalized = request => normalizeModel3dRequest(request, { ...MESHY.limits, formats: MESHY.formats }, 'Meshy');
const flags = error => [error.kind, error.confirmedFailure, error.submissionUnknown, error.retryable];
// A handle survives JSON unchanged and, apart from the API address it was created on, holds no key, URL or image data.
const assertNoSecrets = handle => {
    assert.deepEqual(JSON.parse(JSON.stringify(handle)), handle);
    assert.equal(handle.baseUrl, BASE);
    const text = JSON.stringify({ ...handle, baseUrl: null });
    for (const secret of [KEY, 'Bearer', 'data:', 'base64', 'Expires=', 'Signature=', 'https://']) assert.equal(text.includes(secret), false, secret);
};
const textHandle = { provider: 'meshy', taskId: 'task-1', stage: 'preview', format: 'glb', next: null, history: [], kind: 'text-to-3d', baseUrl: BASE };
const preview = { ...textHandle, next: { stage: 'refine', body: { mode: 'refine', enable_pbr: true, target_formats: ['glb'] } } };
// Every call that creates a billable task, then every call that sends a request at all, for a provider on `baseUrl`.
function callsFor(baseUrl) {
    const creators = [
        (provider, options) => provider.submit({ mode: 'text', prompt: 'x' }, options),
        (provider, options) => provider.submit({ mode: 'image', images: [pngFile] }, options),
        (provider, options) => provider.submit({ mode: 'multiview', images: [pngFile, jpegFile] }, options),
        (provider, options) => provider.advance({ ...preview, baseUrl }, { state: 'succeeded' }, options)
    ];
    return { creators, requests: [...creators, (provider, options) => provider.query({ ...textHandle, baseUrl }, options),
        (provider, options) => provider.cancel({ ...textHandle, baseUrl }, options), (provider, options) => provider.balance(options)] };
}
const { creators, requests } = callsFor(BASE);

test('the info object describes Meshy as documented', () => {
    assert.deepEqual([MESHY.id, MESHY.name, MESHY.docs, MESHY.baseUrl, MESHY.defaultModel, MESHY.maxWaitMs, MESHY.supportsCancel, MESHY.supportsImageUrl],
        ['meshy', 'Meshy', 'docs/api/meshy-3d.md', BASE, 'latest', 3600000, true, true]);
    assert.deepEqual(MESHY.modes, ['text', 'image', 'multiview']);
    assert.deepEqual(MESHY.formats, ['glb', 'fbx', 'obj', 'usdz', 'stl', '3mf']);
    assert.deepEqual(MESHY.limits, { promptMax: 800, multiview: [1, 4], targetFaces: [100, 300000], imageMaxBytes: 20971520,
        imageFormats: ['jpeg', 'png', 'webp'] });
    assert.deepEqual(MESHY.models.map(model => model.id), ['latest', 'meshy-7.1', 'meshy-6', 'meshy-6-lite', 'meshy-t2.5', 'meshy-t2', 'meshy-7']);
    assert.match(MESHY.models.find(model => model.id === 'meshy-7').label, /已废弃/);
    assert.ok(Object.isFrozen(MESHY) && Object.isFrozen(MESHY.limits) && Object.isFrozen(MESHY.models[0]));
    const { provider } = fake();
    assert.equal(provider.info, MESHY);
    assert.deepEqual(Object.keys(provider).sort(), ['advance', 'balance', 'cancel', 'info', 'nextStage', 'pollDelayMs', 'query', 'submit']);
    assert.equal(provider.pollDelayMs(0, null), 5000);
});

test('text mode submits a preview, then refine as a second task that reuses the stored body', async () => {
    const { calls, provider } = fake(accepted('preview-1'), accepted('refine-1'));
    const handle = await provider.submit({ mode: 'text', prompt: ' a monster mask ', format: 'fbx', pbr: false,
        stageOptions: { refine: { texture_resolution: '4k', mode: 'preview', enable_pbr: true, target_formats: ['glb'] } } });
    assert.deepEqual(calls[0], { url: `${BASE}/v2/text-to-3d`, method: 'POST', headers: JSON_HEADERS,
        body: { mode: 'preview', prompt: 'a monster mask' } });
    assert.deepEqual(handle, { provider: 'meshy', taskId: 'preview-1', stage: 'preview', format: 'fbx', history: [], kind: 'text-to-3d', baseUrl: BASE,
        next: { stage: 'refine', body: { texture_resolution: '4k', mode: 'refine', enable_pbr: false, target_formats: ['fbx'] } } });
    assertNoSecrets(handle);

    for (const state of ['queued', 'running', 'failed', 'canceled', 'unknown']) assert.equal(provider.nextStage(handle, { state }), null);
    assert.equal(provider.nextStage(handle, undefined), null);
    assert.deepEqual(provider.nextStage(handle, { state: 'succeeded' }), { stage: 'refine' });
    await assert.rejects(provider.advance(handle, { state: 'running' }), { code: 'MODEL3D_INVALID_REQUEST' });
    assert.equal(calls.length, 1);

    // The saved handle alone is enough to continue after a restart.
    const restored = JSON.parse(JSON.stringify(handle));
    const refined = await provider.advance(restored, { state: 'succeeded' });
    assert.deepEqual(calls[1], { url: `${BASE}/v2/text-to-3d`, method: 'POST', headers: JSON_HEADERS,
        body: { texture_resolution: '4k', mode: 'refine', enable_pbr: false, target_formats: ['fbx'], preview_task_id: 'preview-1' } });
    assert.deepEqual(refined, { provider: 'meshy', taskId: 'refine-1', stage: 'refine', format: 'fbx', next: null,
        history: [{ stage: 'preview', taskId: 'preview-1' }], kind: 'text-to-3d', baseUrl: BASE });
    assertNoSecrets(refined);
    assert.equal(provider.nextStage(refined, { state: 'succeeded' }), null);
    await assert.rejects(provider.advance(refined, { state: 'succeeded' }), { code: 'MODEL3D_INVALID_REQUEST' });
    assert.equal(calls.length, 2);
});

test('the stored refine body is plain JSON, so a restart sends exactly what was planned', async () => {
    const { calls, provider } = fake(accepted('preview-3'), accepted('refine-3'), accepted('refine-4'), accepted('refine-5'), accepted('refine-6'));
    const handle = await provider.submit({ mode: 'text', prompt: 'x', stageOptions: { refine: { texture_prompt: 'say "data: x"', dropped: undefined,
        texture_image_url: 'https://cdn.test/ref.png', nested: { when: new Date(0) } } } });
    const body = { texture_prompt: 'say "data: x"', texture_image_url: 'https://cdn.test/ref.png', nested: { when: '1970-01-01T00:00:00.000Z' },
        mode: 'refine', enable_pbr: true, target_formats: ['glb'] };
    assert.deepEqual(handle.next, { stage: 'refine', body });
    assert.deepEqual(JSON.parse(JSON.stringify(handle)), handle);
    await provider.advance(JSON.parse(JSON.stringify(handle)), { state: 'succeeded' });
    assert.deepEqual(calls[1].body, { ...body, preview_task_id: 'preview-3' });

    // A damaged history must not throw after the refine task has been created: its ID would be lost.
    for (const [index, history] of [undefined, 5].entries()) {
        const refined = await provider.advance({ ...preview, history }, { state: 'succeeded' });
        assert.deepEqual(refined, { provider: 'meshy', taskId: `refine-${index + 4}`, stage: 'refine', format: 'glb', next: null,
            history: [{ stage: 'preview', taskId: 'task-1' }], kind: 'text-to-3d', baseUrl: BASE });
    }
    // The refine always points at the task of the handle, whatever the stored body says.
    await provider.advance({ ...preview, next: { stage: 'refine', body: { ...preview.next.body, preview_task_id: 'stale' } } }, { state: 'succeeded' });
    assert.equal(calls[4].body.preview_task_id, 'task-1');
    assert.equal(calls.length, 5);

    // Without a body nothing was created and nothing can be. A record that is not a Meshy task on this API
    // address is refused as well, but that does not prove its task is gone.
    for (const [broken, confirmedFailure] of [[{ ...preview, next: { stage: 'refine' } }, true], [{ ...preview, next: { stage: 'refine', body: 'refine' } }, true],
        [{ ...preview, taskId: '' }, false], [{ ...preview, kind: 'rigging' }, false], [{ ...preview, provider: 'tripo' }, false],
        [{ ...preview, baseUrl: undefined }, false], [{ ...preview, baseUrl: 'https://relay.test/meshy' }, false]]) {
        const error = await provider.advance(broken, { state: 'succeeded' }).then(() => null, failure => failure);
        assert.deepEqual([error.code, error.confirmedFailure, error.submissionUnknown], ['MODEL3D_INVALID_REQUEST', confirmedFailure, false]);
    }
    assert.equal(calls.length, 5);

    // No refine options, or null, plan the plain refine.
    for (const refine of [undefined, null]) {
        const planned = await fake(accepted('preview-4')).provider.submit({ mode: 'text', prompt: 'x', stageOptions: { refine } });
        assert.deepEqual(planned.next, preview.next);
    }
});

test('an untextured text request ends at the preview and asks for the wanted format there', async () => {
    const { calls, provider } = fake(accepted('preview-2'));
    const handle = await provider.submit({ mode: 'text', prompt: 'a chair', texture: false, stageOptions: { refine: { texture_resolution: '4k' } } });
    assert.deepEqual(calls[0].body, { mode: 'preview', prompt: 'a chair', target_formats: ['glb'] });
    assert.deepEqual(handle, { ...textHandle, taskId: 'preview-2' });
    assert.equal(provider.nextStage(handle, { state: 'succeeded' }), null);
});

test('image mode sends local bytes as a data URI and passes a URL through', async () => {
    const { calls, provider } = fake(accepted('image-1'), accepted('image-2'), accepted('image-3'));
    const local = await provider.submit({ mode: 'image', images: [pngFile] });
    assert.deepEqual(calls[0], { url: `${BASE}/v1/image-to-3d`, method: 'POST', headers: JSON_HEADERS,
        body: { image_url: dataUri('image/png', PNG), should_texture: true, enable_pbr: true, target_formats: ['glb'] } });
    assert.deepEqual(local, { provider: 'meshy', taskId: 'image-1', stage: 'generate', format: 'glb', next: null, history: [], kind: 'image-to-3d',
        baseUrl: BASE });
    assertNoSecrets(local);
    assert.equal(provider.nextStage(local, { state: 'succeeded' }), null);

    const remote = await provider.submit({ mode: 'image', image: 'https://cdn.test/chair.jpg?sig=abc', texture: false, format: 'obj' });
    assert.deepEqual(calls[1].body, { image_url: 'https://cdn.test/chair.jpg?sig=abc', should_texture: false, target_formats: ['obj'] });
    assertNoSecrets(remote);

    // The MIME type comes from the bytes, not from the file name.
    await provider.submit({ mode: 'image', images: [{ path: file('mislabeled.png', JPEG) }], pbr: false });
    assert.deepEqual(calls[2].body, { image_url: dataUri('image/jpeg', JPEG), should_texture: true, enable_pbr: false, target_formats: ['glb'] });
});

test('multiview sends image_urls front first and mixes local files with URLs', async () => {
    const { calls, provider } = fake(accepted('multi-1'), accepted('multi-2'));
    const handle = await provider.submit({ mode: 'multiview', model: 'meshy-6', format: 'usdz', images: [{ source: webpFile, view: 'back' },
        'https://cdn.test/front.png', { source: { buffer: JPEG, name: 'left.jpg' }, view: 'left' }] });
    assert.deepEqual(calls[0], { url: `${BASE}/v1/multi-image-to-3d`, method: 'POST', headers: JSON_HEADERS,
        body: { image_urls: ['https://cdn.test/front.png', dataUri('image/jpeg', JPEG), dataUri('image/webp', WEBP)], ai_model: 'meshy-6',
            should_texture: true, enable_pbr: true, target_formats: ['usdz'] } });
    assert.deepEqual(handle, { provider: 'meshy', taskId: 'multi-1', stage: 'generate', format: 'usdz', next: null, history: [], kind: 'multi-image-to-3d',
        baseUrl: BASE });
    assertNoSecrets(handle);

    await provider.submit({ mode: 'multiview', images: [jpegFile] });
    assert.deepEqual(calls[1].body.image_urls, [dataUri('image/jpeg', JPEG)]);
});

test('unified fields map to Meshy parameters and override providerOptions', () => {
    const overridden = { ai_model: 'meshy-7', should_remesh: false, topology: 'triangle', target_polycount: 1, target_formats: ['glb'] };
    assert.deepEqual(buildMeshyTextBody(normalized({ mode: 'text', prompt: 'a robot', model: 'meshy-6', topology: 'quad', targetFaces: 5000,
        texture: false, format: 'stl', providerOptions: { ...overridden, mode: 'refine', prompt: 'x', pose_mode: 'a-pose' } })),
    { pose_mode: 'a-pose', mode: 'preview', prompt: 'a robot', ai_model: 'meshy-6', should_remesh: true, topology: 'quad',
        target_polycount: 5000, target_formats: ['stl'] });

    // Without a unified value the provider option stands, including parameters the adapter itself never sends (seed).
    // A preview that will be refined never limits its formats.
    assert.deepEqual(buildMeshyTextBody(normalized({ mode: 'text', prompt: 'a robot', providerOptions: { ai_model: 'meshy-6', target_formats: ['glb'], seed: 9 } })),
        { mode: 'preview', prompt: 'a robot', ai_model: 'meshy-6', seed: 9 });
    assert.deepEqual(buildMeshyTextBody(normalized({ mode: 'text', prompt: 'a robot', targetFaces: 300000 })),
        { mode: 'preview', prompt: 'a robot', should_remesh: true, target_polycount: 300000 });
    assert.deepEqual(buildMeshyTextBody(normalized({ mode: 'text', prompt: 'a robot', topology: 'triangle' })),
        { mode: 'preview', prompt: 'a robot', should_remesh: true, topology: 'triangle' });

    assert.deepEqual(buildMeshyRefineBody(normalized({ mode: 'text', prompt: 'a robot', format: '3mf',
        stageOptions: { refine: { texture_prompt: 'rusty', enable_pbr: false, target_formats: ['glb'], mode: 'preview' } } })),
    { texture_prompt: 'rusty', mode: 'refine', enable_pbr: true, target_formats: ['3mf'] });
    assert.deepEqual(buildMeshyRefineBody(normalized({ mode: 'text', prompt: 'a robot', pbr: false })),
        { mode: 'refine', enable_pbr: false, target_formats: ['glb'] });

    assert.deepEqual(buildMeshyImageBody(normalized({ mode: 'image', image: 'a.png', model: 'meshy-7.1', topology: 'quad', targetFaces: 100, format: 'fbx',
        providerOptions: { ...overridden, image_url: 'x', should_texture: false, enable_pbr: false, texture_resolution: '4k' } }), 'https://cdn.test/a.png'),
    { image_url: 'https://cdn.test/a.png', ai_model: 'meshy-7.1', should_remesh: true, topology: 'quad', target_polycount: 100,
        should_texture: true, enable_pbr: true, target_formats: ['fbx'], texture_resolution: '4k' });
    // enable_pbr without texturing is a 400, and input_task_id would take the place of the image.
    assert.deepEqual(buildMeshyImageBody(normalized({ mode: 'image', image: 'a.png', texture: false,
        providerOptions: { enable_pbr: true, input_task_id: 'task-0' } }), 'u'), { image_url: 'u', should_texture: false, target_formats: ['glb'] });

    assert.deepEqual(buildMeshyMultiviewBody(normalized({ mode: 'multiview', images: ['a.png', 'b.png'], pbr: false, targetFaces: 2000,
        providerOptions: { image_urls: ['x'], input_task_id: 'task-0', geometry_resolution: '2k' } }), ['u1', 'u2']),
    { image_urls: ['u1', 'u2'], geometry_resolution: '2k', should_remesh: true, target_polycount: 2000, should_texture: true,
        enable_pbr: false, target_formats: ['glb'] });
});

test('Smart Topology models take model_type and the face count without remeshing, and only where Meshy offers them', () => {
    for (const [model, maxFaces] of [['meshy-t2', 15000], ['meshy-t2.5', 30000]]) {
        assert.deepEqual(buildMeshyTextBody(normalized({ mode: 'text', prompt: 'a crate', model, texture: false, topology: 'triangle', targetFaces: maxFaces })),
            { mode: 'preview', prompt: 'a crate', ai_model: model, model_type: 'smart-topology', topology: 'triangle', target_polycount: maxFaces,
                target_formats: ['glb'] });
        assert.deepEqual(buildMeshyImageBody(normalized({ mode: 'image', image: 'a.png', model }), 'u'),
            { image_url: 'u', ai_model: model, model_type: 'smart-topology', should_texture: true, enable_pbr: true, target_formats: ['glb'] });
        assert.throws(() => buildMeshyTextBody(normalized({ mode: 'text', prompt: 'a crate', model, targetFaces: maxFaces + 1 })),
            { code: 'MODEL3D_INVALID_REQUEST', confirmedFailure: true });
        assert.throws(() => buildMeshyImageBody(normalized({ mode: 'image', image: 'a.png', model, topology: 'quad' }), 'u'),
            { code: 'MODEL3D_INVALID_REQUEST', confirmedFailure: true });
        // multi-image-to-3d has no model_type and does not accept these models.
        assert.throws(() => buildMeshyMultiviewBody(normalized({ mode: 'multiview', images: ['a.png'], model }), ['u']),
            { code: 'MODEL3D_UNSUPPORTED', confirmedFailure: true });
    }
    assert.equal('model_type' in buildMeshyTextBody(normalized({ mode: 'text', prompt: 'a crate', model: 'meshy-7.1' })), false);
});

test('requests that cannot be sent are rejected locally without any network call', async () => {
    const { calls, provider } = fake();
    const loop = {};
    loop.self = loop;
    const cases = [
        // No Meshy documentation page has a seed parameter, so the adapter never sends one.
        [{ mode: 'text', prompt: 'x', seed: 7 }, 'MODEL3D_UNSUPPORTED'],
        [{ mode: 'image', images: [pngFile], seed: 7 }, 'MODEL3D_UNSUPPORTED'],
        [{ mode: 'multiview', images: [pngFile, jpegFile], seed: 7 }, 'MODEL3D_UNSUPPORTED'],
        [{ mode: 'text', prompt: 'x', model: 'meshy-t2', topology: 'quad' }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'image', images: [pngFile], model: 'meshy-t2', targetFaces: 15001 }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'multiview', images: [pngFile, jpegFile], model: 'meshy-t2.5' }, 'MODEL3D_UNSUPPORTED'],
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: { texture_image_url: dataUri('image/png', PNG) } } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: { texture_image_url: ` ${dataUri('image/png', PNG)}` } } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: { experimental: { images: [dataUri('image/png', PNG)] } } } }, 'MODEL3D_INVALID_REQUEST'],
        // Whitespace that JSON writes as an escape, and base64 data in the middle of a text, are still image data.
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: { texture_image_url: `\n\t${dataUri('image/png', PNG)}` } } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: { texture_prompt: `like ${dataUri('image/png', PNG)}` } } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: 'texture' } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: ['texture'] } }, 'MODEL3D_INVALID_REQUEST'],
        // A body that JSON turns into something other than an object could never be submitted after the preview was paid for.
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: { toJSON: () => 'refine' } } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: { toJSON: () => undefined } } }, 'MODEL3D_INVALID_REQUEST'],
        // A body that cannot be written as JSON never leaves the machine, so it is not an unknown submission.
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: { loop } } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x', stageOptions: { refine: { count: 1n } } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x', texture: false, providerOptions: { count: 1n } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'image', images: [pngFile], providerOptions: { loop } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'multiview', images: [pngFile, jpegFile], providerOptions: { loop } }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x'.repeat(801) }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x', targetFaces: 99 }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'text', prompt: 'x', format: 'blend' }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'multiview', images: [pngFile, pngFile, pngFile, pngFile, pngFile] }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'image', images: [path.join(dir, 'missing.png')] }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'image', images: [file('anim.gif', Buffer.from('GIF89a000000'))] }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'image', images: [{ buffer: Buffer.concat([PNG, Buffer.alloc(MESHY.limits.imageMaxBytes)]), name: 'big.png' }] }, 'MODEL3D_INVALID_REQUEST'],
        [{ mode: 'image', images: [{ url: 'ftp://cdn.test/a.png' }] }, 'MODEL3D_INVALID_REQUEST']
    ];
    for (const [index, [request, code]] of cases.entries()) {
        const error = await provider.submit(request).catch(caught => caught);
        assert.deepEqual([error.code, error.confirmedFailure, error.submissionUnknown], [code, true, false], `case ${index}`);
    }
    assert.equal(calls.length, 0);
    await assert.rejects(provider.advance({ ...preview, next: { stage: 'refine', body: { loop } } }, { state: 'succeeded' }),
        { code: 'MODEL3D_INVALID_REQUEST', confirmedFailure: true, submissionUnknown: false });
    assert.equal(calls.length, 0);
    assert.throws(() => createMeshyProvider({ apiKey: '' }), { code: 'MODEL3D_AUTH_FAILED' });
    assert.throws(() => createMeshyProvider({ apiKey: KEY, baseUrl: 'http://api.meshy.ai/openapi' }), { code: 'MODEL3D_INVALID_REQUEST' });
});

test('every request carries the key to the configured base only and refuses redirects', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
        seen.push([`${init.method} ${url}`, init.headers.Authorization, init.redirect]);
        return init.method === 'POST' ? accepted('t') : response(200, init.method === 'GET' ? { status: 'PENDING', balance: 1 } : undefined);
    };
    const relay = 'https://relay.test/meshy';
    const provider = createMeshyProvider({ apiKey: KEY, baseUrl: `${relay}/`, fetchImpl });
    const handles = [];
    for (const send of callsFor(relay).requests) handles.push(await send(provider));
    // Handles carry the address they were created on, so a restart can tell where their tasks live.
    assert.deepEqual(handles.slice(0, 4).map(handle => handle.baseUrl), Array(4).fill(relay));
    // Nothing in a handle can point a request at another host: the address is compared, and the ID is one path segment.
    for (const moved of [{ ...textHandle, baseUrl: 'https://evil.test' }, textHandle, { ...textHandle, baseUrl: `${relay}/` }]) {
        for (const method of ['query', 'cancel']) {
            await assert.rejects(provider[method](moved), { code: 'MODEL3D_INVALID_REQUEST', confirmedFailure: false, submissionUnknown: false });
        }
        await assert.rejects(provider.advance({ ...preview, baseUrl: moved.baseUrl }, { state: 'succeeded' }),
            { code: 'MODEL3D_INVALID_REQUEST', confirmedFailure: false, submissionUnknown: false });
    }
    await provider.query({ ...textHandle, taskId: 'https://evil.test/x', baseUrl: relay, kind: 'image-to-3d' });
    assert.deepEqual(seen.map(entry => entry[0]), [`POST ${relay}/v2/text-to-3d`, `POST ${relay}/v1/image-to-3d`, `POST ${relay}/v1/multi-image-to-3d`,
        `POST ${relay}/v2/text-to-3d`, `GET ${relay}/v2/text-to-3d/task-1`, `GET ${relay}/v2/text-to-3d/task-1`, `DELETE ${relay}/v2/text-to-3d/task-1`,
        `GET ${relay}/v1/balance`, `GET ${relay}/v1/image-to-3d/https%3A%2F%2Fevil.test%2Fx`]);
    // redirect: 'error' keeps the Authorization header from following a redirect to another host.
    assert.deepEqual(seen.map(entry => entry.slice(1)), Array(9).fill([`Bearer ${KEY}`, 'error']));
});

test('every documented create failure maps to its kind and nothing is sent twice', async () => {
    const cases = [
        [response(400, { message: 'Invalid model file extension: .3dm' }), ['rejected', true, false, false], /请求被拒绝（Invalid model file extension: \.3dm）/],
        [response(401, { message: 'Invalid API key' }), ['auth', true, false, false], /Invalid API key/],
        [response(402, { message: 'Insufficient credits' }), ['credits', true, false, false], /积分不足/],
        // The body carries only `message`, so a moderation block cannot be told from an IP or plan restriction.
        [response(403, { message: 'Content blocked by moderation' }), ['forbidden', true, false, false], /Content blocked by moderation/],
        [response(404, { message: 'Task not found' }), ['rejected', true, false, false], /Task not found/],
        [response(409, { message: 'Conflict' }), ['rejected', true, false, false], /Conflict/],
        [response(422, { message: 'Unprocessable' }), ['rejected', true, false, false], /Unprocessable/],
        [response(429, { message: 'Rate limit exceeded' }, { 'Retry-After': '2' }), ['rateLimited', true, false, true], /Rate limit exceeded/],
        [response(429, { message: 'NoMorePendingTasks: too many tasks' }), ['rateLimited', true, false, true], /NoMorePendingTasks/],
        [response(400, '<html>bad request</html>'), ['rejected', true, false, false], /HTTP 400/]
    ];
    for (const [reply, expected, message] of cases) {
        for (const send of creators) {
            const { calls, provider } = fake(reply);
            const error = await send(provider).catch(caught => caught);
            assert.deepEqual(flags(error), expected, String(message));
            assert.match(error.message, message);
            assert.match(error.message, /^Meshy：/);
            assert.equal(error.status, reply.status);
            assert.equal(calls.length, 1);
        }
    }
    const limited = fake(response(429, { message: 'Rate limit exceeded' }, { 'Retry-After': '2' }), response(429, { message: 'NoMoreConcurrentTasks' }));
    assert.equal((await limited.provider.submit({ mode: 'image', images: [pngFile] }).catch(caught => caught)).retryAfterMs, 2000);
    assert.equal((await limited.provider.submit({ mode: 'multiview', images: [pngFile] }).catch(caught => caught)).retryAfterMs, null);

});

test('no error text carries the key or image data, whatever the server or the network layer echoes', async () => {
    const echo = response(400, { message: `bad image_url ${dataUri('image/png', PNG)} for key ${KEY}` });
    const quoting = () => { throw new Error(`socket closed while sending Authorization: Bearer ${KEY}`); };
    for (const send of requests) {
        const rejected = await send(fake(echo).provider).catch(caught => caught);
        assert.match(rejected.message, /bad image_url data:… for key \*\*\*/);
        const dropped = await send(fake(quoting).provider).catch(caught => caught);
        assert.match(dropped.message, /sending Authorization: Bearer \*\*\*/);
        for (const error of [rejected, dropped]) assert.equal(/msy_test|base64/.test(`${error.message} ${JSON.stringify(error)}`), false);
    }
    // The second request of cancel goes through the same redaction.
    for (const reply of [echo, quoting]) {
        const error = await fake(response(200, { status: 'PENDING' }), reply).provider.cancel(textHandle).catch(caught => caught);
        assert.match(error.message, /Bearer \*\*\*|for key \*\*\*/);
        assert.equal(error.message.includes(KEY), false);
    }
    // Everything a task object contributes to a status, and from there to an error, is cleaned the same way.
    const failed = fake(response(200, { status: 'FAILED', task_error: { type: 'server_error', code: `refused_${KEY}`, message: `upstream refused ${KEY}` } }),
        response(200, { status: `HELD ${KEY} ${dataUri('image/png', PNG)}` }));
    assert.deepEqual((await failed.provider.query(textHandle)).error, { code: 'refused_***', message: '服务内部错误：upstream refused ***', retryable: true });
    const held = await failed.provider.query(textHandle);
    assert.deepEqual([held.state, held.remoteStatus], ['unknown', 'HELD *** data:…']);
});

test('an accepted create without a task ID is an unknown submission, not a safe failure', async () => {
    for (const reply of [response(202, {}), response(202, { result: '' }), response(202, { result: 123 }), response(202, { result: null }),
        response(202, { id: 'task-9' }), response(202, ['task-9']), response(202, 'accepted'), response(202, '{"result": "task-9"'), response(200),
        response(204)]) {
        for (const send of creators) {
            const { calls, provider } = fake(reply);
            const error = await send(provider).catch(caught => caught);
            assert.deepEqual([error.code, ...flags(error)], ['MODEL3D_INVALID_RESPONSE', 'invalidResponse', false, true, false]);
            assert.equal(calls.length, 1);
        }
    }
    // The task exists whichever success status carries its ID, so the ID is never thrown away.
    for (const status of [200, 201, 202]) {
        for (const send of creators) assert.equal((await send(fake(response(status, { result: 'task-9', message: 'ok' })).provider)).taskId, 'task-9');
    }
});

test('a create that returns 5xx or loses the connection is sent exactly once and reported as unknown', async () => {
    // The body of a 202 that breaks off while it is read leaves the outcome just as open as a dropped connection.
    const truncated = { status: 202, headers: new Headers(), text: async () => { throw new TypeError('terminated'); } };
    // 408 and 425 are 4xx, but the server may already have started on the request.
    for (const reply of [response(500, { message: 'internal' }), response(502, '<html>bad gateway</html>'), response(503, {}, { 'Retry-After': '1' }),
        response(504), response(408, { message: 'Request Timeout' }), response(425, { message: 'Too Early' }),
        response(301, undefined, { Location: `${BASE}/v2/text-to-3d` }), truncated, dropped('ECONNRESET'), dropped('UND_ERR_SOCKET')]) {
        for (const send of creators) {
            const { calls, provider } = fake(reply);
            const error = await send(provider).catch(caught => caught);
            assert.deepEqual([error.code, ...flags(error)], ['MODEL3D_SUBMISSION_UNKNOWN', 'submissionUnknown', false, true, false]);
            assert.equal(calls.length, 1);
        }
    }
    // Only a connection that was never opened proves that no task exists.
    for (const send of creators) {
        const refused = fake(dropped('ECONNREFUSED'));
        assert.deepEqual(flags(await send(refused.provider).catch(caught => caught)), ['network', true, false, true]);
        assert.equal(refused.calls.length, 1);
    }
});

test('every method hands the abort signal on, and an abort stays an abort', async () => {
    const shape = error => [error.name, error.code, error.kind, error.submissionUnknown, error.confirmedFailure];
    const abort = ['AbortError', 'GENERATION_CANCELED', undefined, undefined, undefined];
    // A create request interrupted in flight may already have created a billed task, so only that abort carries
    // the warning; one that came before the request went out says so explicitly.
    const flagged = (send, unknown) => abort.with(3, creators.includes(send) ? unknown : undefined);
    for (const send of requests) {
        const early = fake();
        assert.deepEqual(shape(await send(early.provider, { signal: AbortSignal.abort() }).catch(caught => caught)), flagged(send, false));
        assert.equal(early.calls.length, 0);

        const controller = new AbortController();
        const inFlight = fake((url, init) => { queueMicrotask(() => controller.abort()); return hang(url, init); });
        assert.deepEqual(shape(await send(inFlight.provider, { signal: controller.signal }).catch(caught => caught)), flagged(send, true));
        assert.equal(inFlight.calls.length, 1);
    }
    // An abort between the two requests of cancel stops the DELETE.
    const controller = new AbortController();
    const between = fake(() => { controller.abort(); return response(200, { status: 'PENDING' }); });
    assert.deepEqual(shape(await between.provider.cancel(textHandle, { signal: controller.signal }).catch(caught => caught)), abort);
    assert.deepEqual(between.calls.map(call => call.method), ['GET']);

    // An abort that arrives together with the answer of a create does not throw the task ID away: the task exists and is billed.
    for (const send of creators) {
        const late = new AbortController();
        const answered = fake(() => { late.abort(); return accepted('task-7'); });
        assert.equal((await send(answered.provider, { signal: late.signal })).taskId, 'task-7');
        assert.equal(answered.calls.length, 1);
    }
});

test('create requests time out after 60 seconds and queries after 30, each with a single request', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const settle = () => new Promise(resolve => setImmediate(resolve));

    const create = fake(hang);
    let createError = null;
    create.provider.submit({ mode: 'text', prompt: 'x' }).catch(error => { createError = error; });
    t.mock.timers.tick(59999);
    await settle();
    assert.equal(createError, null);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual([createError.code, ...flags(createError)], ['MODEL3D_SUBMISSION_UNKNOWN', 'submissionUnknown', false, true, false]);
    assert.equal(create.calls.length, 1);

    const poll = fake(hang);
    let queryError = null;
    poll.provider.query(textHandle).catch(error => { queryError = error; });
    t.mock.timers.tick(29999);
    await settle();
    assert.equal(queryError, null);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual([queryError.code, queryError.transient, queryError.confirmedFailure], ['MODEL3D_STATUS_UNAVAILABLE', true, false]);
    assert.equal(poll.calls.length, 1);
});

test('query uses the prefix of the task kind and maps every status value', async () => {
    const kinds = { 'text-to-3d': '/v2/text-to-3d', 'image-to-3d': '/v1/image-to-3d', 'multi-image-to-3d': '/v1/multi-image-to-3d' };
    for (const [kind, prefix] of Object.entries(kinds)) {
        const { calls, provider } = fake(response(200, { id: 'a/b', status: 'IN_PROGRESS', progress: 42 }, { 'Retry-After': '3' }));
        const status = await provider.query({ ...textHandle, kind, taskId: 'a/b' });
        assert.deepEqual(calls, [{ url: `${BASE}${prefix}/a%2Fb`, method: 'GET', headers: AUTH, body: undefined }]);
        assert.deepEqual(status, { state: 'running', progress: 42, remoteStatus: 'IN_PROGRESS', outputs: [], error: null, creditsConsumed: null,
            expiresAt: null, retryAfterMs: 3000 });
    }
    for (const [remote, state] of [['PENDING', 'queued'], ['IN_PROGRESS', 'running'], ['SUCCEEDED', 'succeeded'], ['FAILED', 'failed'],
        ['CANCELED', 'canceled'], ['RESCHEDULED', 'unknown'], ['pending', 'unknown'], ['constructor', 'unknown']]) {
        const status = meshyStatus({ id: 't', status: remote, progress: 0 }, 'glb');
        assert.deepEqual([status.state, status.remoteStatus, status.retryAfterMs], [state, remote, null]);
    }

    // A task may be rescheduled from IN_PROGRESS back to PENDING with its progress reset.
    const { provider } = fake(response(200, { status: 'IN_PROGRESS', progress: 60 }), response(200, { status: 'PENDING', progress: 0, preceding_tasks: 2 }));
    assert.deepEqual([(await provider.query(textHandle)).state, (await provider.query(textHandle)).state], ['running', 'queued']);

    // Progress stays within 0 to 100 and is null when Meshy sends no number.
    for (const [progress, expected] of [[150, 100], [-5, 0], [33.5, 33.5], ['50', null], [undefined, null], [NaN, null]]) {
        assert.equal(meshyStatus({ status: 'IN_PROGRESS', progress }, 'glb').progress, expected);
    }
});

test('query lists the format the handle asks for first', async () => {
    const url = name => `https://assets.meshy.ai/u/tasks/t/output/${name}?Expires=1&Signature=s`;
    const task = { status: 'SUCCEEDED', progress: 100, model_urls: { glb: url('model.glb'), fbx: url('model.fbx') } };
    const { provider } = fake(response(200, task), response(200, task));
    assert.deepEqual((await provider.query({ ...textHandle, format: 'fbx' })).outputs.map(output => output.format), ['fbx', 'glb']);
    assert.deepEqual((await provider.query(textHandle)).outputs.map(output => output.format), ['glb', 'fbx']);
});

test('a succeeded task lists the wanted model first, then other files, textures and the thumbnail', () => {
    const url = name => `https://assets.meshy.ai/u/tasks/t/output/${name}?Expires=1&Signature=s`;
    const task = { id: 't', type: 'image-to-3d', status: 'SUCCEEDED', progress: 100, consumed_credits: 30, expires_at: 1692771679037,
        task_error: { message: '' },
        model_urls: { glb: url('model.glb'), fbx: url('model.fbx'), obj: url('model.obj'), mtl: url('model.mtl'),
            pre_remeshed_glb: url('pre_remeshed_model.glb'), usdz: '' },
        texture_urls: [{ base_color: url('texture_0.png'), metallic: url('texture_0_metallic.png') }],
        thumbnail_url: url('preview.png') };
    const status = meshyStatus(task, 'fbx', 5000);
    assert.deepEqual(status.outputs.map(output => [output.role, output.format, output.name]), [['model', 'fbx', 'fbx'], ['model', 'glb', 'glb'],
        ['model', 'obj', 'obj'], ['model', 'mtl', 'mtl'], ['model', 'glb', 'pre_remeshed_glb'], ['texture', 'png', 'base_color'],
        ['texture', 'png', 'metallic'], ['thumbnail', 'png', null]]);
    assert.equal(status.outputs[0].url, url('model.fbx'));
    assert.deepEqual([status.state, status.progress, status.error, status.creditsConsumed, status.expiresAt, status.retryAfterMs],
        ['succeeded', 100, null, 30, 1692771679037, 5000]);
    assert.equal(meshyStatus(task, 'glb').outputs[0].name, 'glb');
    // The wanted format is missing: the order of the response is kept.
    assert.equal(meshyStatus(task, 'stl').outputs[0].name, 'glb');

    // Text-to-3D tasks have no expires_at, and most fields may be absent or null.
    assert.deepEqual(meshyStatus({ id: 't', status: 'SUCCEEDED', progress: 100, texture_urls: null, consumed_credits: null, expires_at: 0 }, 'glb'),
        { state: 'succeeded', progress: 100, remoteStatus: 'SUCCEEDED', outputs: [], error: null, creditsConsumed: null, expiresAt: null, retryAfterMs: null });
    assert.deepEqual(meshyStatus({ status: 'PENDING', model_urls: { glb: url('model.glb') } }, 'glb').outputs, []);

    // A link without a file extension still gets the format of its key, so the wanted model can be found.
    // Entries that are not links are left out instead of breaking the status of a finished task.
    const bare = name => `https://assets.meshy.ai/dl/${name}?Expires=1&Signature=s`;
    const odd = meshyStatus({ status: 'SUCCEEDED', model_urls: { obj: bare('a'), mtl: bare('b'), glb: bare('c'), pre_remeshed_glb: bare('d'), stl: { href: 'x' }, fbx: null },
        texture_urls: [null, 'x', { base_color: bare('e'), normal: 7 }], thumbnail_url: 5 }, 'glb');
    assert.deepEqual(odd.outputs.map(output => [output.role, output.format, output.name]), [['model', 'glb', 'glb'], ['model', 'obj', 'obj'],
        ['model', 'mtl', 'mtl'], ['model', null, 'pre_remeshed_glb'], ['texture', null, 'base_color']]);
    assert.deepEqual(meshyStatus({ status: 'SUCCEEDED', model_urls: 'none', texture_urls: 'none' }, 'glb').outputs, []);
});

test('a failed task is retryable by error type, not by code', () => {
    const failed = task_error => meshyStatus({ id: 't', status: 'FAILED', progress: 0, consumed_credits: 0, task_error }, 'glb');
    assert.deepEqual(failed({ type: 'invalid_input', code: 'image_too_complex', message: 'The uploaded image is too complex for 3D generation.' }).error,
        { code: 'image_too_complex', message: '输入不符合要求：The uploaded image is too complex for 3D generation.', retryable: false });
    assert.deepEqual(failed({ type: 'server_error', message: 'An internal error occurred. Please retry.' }).error,
        { code: 'server_error', message: '服务内部错误：An internal error occurred. Please retry.', retryable: true });
    assert.deepEqual(failed({ type: 'timeout', code: 'queue_timeout', message: 'Queued too long' }).error,
        { code: 'queue_timeout', message: '服务端处理或排队超时：Queued too long', retryable: true });
    assert.equal(failed({ type: 'service_unavailable', message: 'busy' }).error.retryable, true);
    assert.equal(failed({ type: 'server_error', code: 'moderation_unavailable', message: 'm' }).error.retryable, true);
    // Without a documented type nothing says a new task could succeed.
    assert.deepEqual(failed({ code: 'moderation_blocked', message: 'blocked' }).error, { code: 'moderation_blocked', message: '任务失败：blocked', retryable: false });
    assert.deepEqual(failed({ type: 'quota', message: 'new type' }).error, { code: 'quota', message: '任务失败：new type', retryable: false });
    assert.deepEqual(failed(null).error, { code: 'FAILED', message: '任务失败', retryable: false });
    // The remote text is shown without image data, and only when it is text.
    assert.equal(failed({ type: 'invalid_input', message: `cannot read ${dataUri('image/png', PNG)}` }).error.message, '输入不符合要求：cannot read data:…');
    assert.deepEqual(failed({ type: 'server_error', message: { text: 'm' } }).error, { code: 'server_error', message: '服务内部错误', retryable: true });
    const status = failed({ type: 'server_error', message: 'm' });
    assert.deepEqual([status.state, status.creditsConsumed, status.outputs], ['failed', 0, []]);
    assert.equal(meshyStatus({ status: 'CANCELED', task_error: { type: 'server_error', message: 'm' } }, 'glb').error, null);
});

test('query failures never fail the task: timeouts, 429 and 5xx are transient, the rest is reported', async () => {
    const failure = async (...script) => {
        const { calls, provider } = fake(...script);
        const error = await provider.query(textHandle).catch(caught => caught);
        assert.equal(calls.length, 1);
        assert.equal(error.confirmedFailure, false);
        return error;
    };
    const limited = await failure(response(429, { message: 'Rate limit exceeded' }, { 'Retry-After': '4' }));
    assert.deepEqual([limited.code, limited.transient, limited.retryAfterMs], ['MODEL3D_STATUS_UNAVAILABLE', true, 4000]);
    assert.match(limited.message, /Rate limit exceeded/);
    for (const reply of [response(500, { message: 'internal' }), response(503, '<html></html>'), dropped('ECONNRESET'), dropped('ENOTFOUND')]) {
        const error = await failure(reply);
        assert.deepEqual([error.code, error.transient], ['MODEL3D_STATUS_UNAVAILABLE', true]);
    }
    const bad = await failure(response(400, { message: 'bad' }));
    assert.deepEqual([bad.code, bad.transient], ['MODEL3D_STATUS_UNAVAILABLE', false]);
    assert.equal((await failure(response(401, { message: 'Invalid API key' }))).code, 'MODEL3D_AUTH_FAILED');
    const missing = await failure(response(404, { message: 'Task not found' }));
    assert.deepEqual([missing.code, Boolean(missing.transient)], ['MODEL3D_TASK_NOT_FOUND', false]);
    for (const reply of [response(200, '<html>gateway</html>'), response(200, { id: 't' }), response(200, [])]) {
        const error = await failure(reply);
        assert.deepEqual([error.code, error.transient], ['MODEL3D_INVALID_RESPONSE', true]);
    }

    // A record that cannot be used says nothing about its task, and no request is sent for it.
    const { calls, provider } = fake();
    for (const handle of [null, {}, { ...textHandle, taskId: '' }, { ...textHandle, taskId: 7 }, { ...textHandle, kind: 'rigging' },
        { ...textHandle, kind: 'constructor' }, { ...textHandle, provider: 'tripo' }, { ...textHandle, baseUrl: undefined },
        { ...textHandle, baseUrl: 'https://api.meshy.ai' }]) {
        for (const method of ['query', 'cancel']) {
            await assert.rejects(provider[method](handle), { code: 'MODEL3D_INVALID_REQUEST', confirmedFailure: false, submissionUnknown: false });
        }
    }
    assert.equal(calls.length, 0);
});

test('cancel deletes only a queued task, so a finished result is never removed', async () => {
    const queued = fake(response(200, { status: 'PENDING', progress: 0 }), response(200));
    const handle = { ...textHandle, kind: 'image-to-3d', taskId: 'image-9' };
    assert.deepEqual(await queued.provider.cancel(handle), { supported: true, canceled: true, detail: '排队中的任务已删除，Meshy 会退回创建时扣的积分' });
    assert.deepEqual(queued.calls, [{ url: `${BASE}/v1/image-to-3d/image-9`, method: 'GET', headers: AUTH, body: undefined },
        { url: `${BASE}/v1/image-to-3d/image-9`, method: 'DELETE', headers: AUTH, body: undefined }]);

    // Only the status code of the DELETE counts: the docs disagree on whether its body is empty or a JSON object.
    const described = fake(response(200, { status: 'PENDING', progress: 0 }), response(200, { message: 'deleted' }));
    assert.equal((await described.provider.cancel(textHandle)).canceled, true);

    const running = fake(response(200, { status: 'IN_PROGRESS', progress: 10 }));
    const refused = await running.provider.cancel(textHandle);
    assert.deepEqual([refused.supported, refused.canceled], [true, false]);
    assert.match(refused.detail, /不能取消运行中的任务/);
    assert.equal(running.calls.length, 1);

    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELED', 'RESCHEDULED']) {
        const finished = fake(response(200, { status, progress: 100 }));
        const result = await finished.provider.cancel(textHandle);
        assert.deepEqual([result.supported, result.canceled], [true, false]);
        assert.match(result.detail, new RegExp(status));
        assert.deepEqual(finished.calls.map(call => call.method), ['GET']);
    }

    // The task started between the two requests.
    const raced = fake(response(200, { status: 'PENDING' }), response(409, { message: 'Task is IN_PROGRESS and cannot be deleted.' }));
    const lost = await raced.provider.cancel(textHandle);
    assert.deepEqual([lost.supported, lost.canceled], [true, false]);
    assert.match(lost.detail, /不能取消运行中的任务/);
    assert.deepEqual(raced.calls.map(call => `${call.method} ${call.url}`), [`GET ${BASE}/v2/text-to-3d/task-1`, `DELETE ${BASE}/v2/text-to-3d/task-1`]);

    const broken = fake(response(200, { status: 'PENDING' }), response(500, { message: 'internal' }));
    await assert.rejects(broken.provider.cancel(textHandle), { code: 'MODEL3D_STATUS_UNAVAILABLE', transient: true });
    const gone = fake(response(200, { status: 'PENDING' }), response(404, { message: 'Task not found' }));
    await assert.rejects(gone.provider.cancel(textHandle), { code: 'MODEL3D_TASK_NOT_FOUND' });
    const offline = fake(dropped('ECONNRESET'));
    await assert.rejects(offline.provider.cancel(textHandle), { code: 'MODEL3D_STATUS_UNAVAILABLE', transient: true });
});

test('balance returns the available credits and keeps the other fields as detail', async () => {
    const { calls, provider } = fake(response(200, { balance: 1000, monthly_credits: 600, permanent_credits: 400, monthly_resets_at: 1793491200000 }));
    assert.deepEqual(await provider.balance(), { balance: 1000, unit: 'credits',
        detail: { monthly_credits: 600, permanent_credits: 400, monthly_resets_at: 1793491200000 } });
    assert.deepEqual(calls, [{ url: `${BASE}/v1/balance`, method: 'GET', headers: AUTH, body: undefined }]);

    await assert.rejects(fake(response(401, { message: 'Invalid API key' })).provider.balance(), { code: 'MODEL3D_AUTH_FAILED' });
    await assert.rejects(fake(response(429, { message: 'Rate limit exceeded' }, { 'Retry-After': '1' })).provider.balance(),
        error => error.code === 'MODEL3D_RATE_LIMITED' && error.retryAfterMs === 1000 && !/任务/.test(error.message));
    await assert.rejects(fake(response(503, 'down')).provider.balance(), error => error.code === 'MODEL3D_SERVICE_UNAVAILABLE' && !/任务/.test(error.message));
    // A balance read that gets no answer is a network problem, not a task whose status is unknown.
    await assert.rejects(fake(dropped('ECONNRESET')).provider.balance(), error => error.code === 'MODEL3D_NETWORK_UNAVAILABLE' && !/任务/.test(error.message));
    for (const reply of [response(200, {}), response(200, { balance: '1000' }), response(200, 'ok')]) {
        await assert.rejects(fake(reply).provider.balance(), { code: 'MODEL3D_INVALID_RESPONSE' });
    }
});

test('through the shared entry points a textured text model costs one preview and one refine, never more', async () => {
    const wait = async () => {};
    const done = response(200, { status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://assets.meshy.ai/t/model.glb?Expires=1&Signature=s' } });
    const sent = calls => calls.map(call => `${call.method} ${call.url.slice(BASE.length)}`);
    const recorder = () => { const saved = []; return { saved, onHandle: handle => saved.push(JSON.parse(JSON.stringify(handle))) }; };
    const request = { mode: 'text', prompt: 'a chair' };

    const whole = fake(accepted('preview-1'), response(200, { status: 'IN_PROGRESS', progress: 50 }), response(503, 'busy'), done, accepted('refine-1'), done);
    const first = recorder();
    const result = await generateModel3d({ provider: whole.provider, request, wait, onHandle: first.onHandle });
    // A failed status read in the middle neither fails the task nor creates another one.
    assert.deepEqual(sent(whole.calls), ['POST /v2/text-to-3d', 'GET /v2/text-to-3d/preview-1', 'GET /v2/text-to-3d/preview-1',
        'GET /v2/text-to-3d/preview-1', 'POST /v2/text-to-3d', 'GET /v2/text-to-3d/refine-1']);
    assert.deepEqual(first.saved.map(handle => [handle.taskId, handle.stage, handle.advancing ?? null]),
        [['preview-1', 'preview', null], ['preview-1', 'preview', 'refine'], ['refine-1', 'refine', null]]);
    assert.deepEqual([result.handle.taskId, result.primary.format, result.status.state], ['refine-1', 'glb', 'succeeded']);

    // A refine whose outcome is unknown stays marked in the saved record, and a restart sends nothing for it.
    for (const reply of [response(502, '<html>bad gateway</html>'), response(202, {}), dropped('ECONNRESET')]) {
        const unknown = fake(accepted('preview-2'), done, reply);
        const second = recorder();
        const error = await generateModel3d({ provider: unknown.provider, request, wait, onHandle: second.onHandle }).catch(caught => caught);
        assert.deepEqual([error.submissionUnknown, error.confirmedFailure, error.handle.taskId, error.handle.advancing], [true, false, 'preview-2', 'refine']);
        assert.deepEqual(second.saved.at(-1), { ...preview, taskId: 'preview-2', advancing: 'refine' });
        assert.equal(unknown.calls.filter(call => call.method === 'POST').length, 2);
        const restart = fake();
        const blocked = await resumeModel3d({ provider: restart.provider, handle: second.saved.at(-1), wait }).catch(caught => caught);
        assert.deepEqual([blocked.code, blocked.submissionUnknown, restart.calls.length], ['MODEL3D_SUBMISSION_UNKNOWN', true, 0]);
    }

    // A refine that Meshy refused was not created: the record goes back to the preview, and a restart sends the refine once.
    const refused = fake(accepted('preview-3'), done, response(429, { message: 'NoMorePendingTasks: too many tasks' }));
    const third = recorder();
    const limited = await generateModel3d({ provider: refused.provider, request, wait, onHandle: third.onHandle }).catch(caught => caught);
    assert.deepEqual([limited.code, limited.handle.taskId, limited.handle.advancing], ['MODEL3D_RATE_LIMITED', 'preview-3', undefined]);
    assert.deepEqual(third.saved.at(-1), { ...preview, taskId: 'preview-3' });
    const later = fake(done, accepted('refine-3'), done);
    const resumed = await resumeModel3d({ provider: later.provider, handle: third.saved.at(-1), wait });
    assert.deepEqual(sent(later.calls), ['GET /v2/text-to-3d/preview-3', 'POST /v2/text-to-3d', 'GET /v2/text-to-3d/refine-3']);
    assert.deepEqual(later.calls[1].body, { ...preview.next.body, preview_task_id: 'preview-3' });
    assert.deepEqual([resumed.handle.taskId, resumed.handle.history], ['refine-3', [{ stage: 'preview', taskId: 'preview-3' }]]);

    // A failed preview ends the run: the refine is never sent.
    const failing = fake(accepted('preview-4'), response(200, { status: 'FAILED', task_error: { type: 'server_error', message: 'internal' } }));
    const failure = await generateModel3d({ provider: failing.provider, request, wait }).catch(caught => caught);
    assert.deepEqual([failure.code, failure.confirmedFailure, failure.retryable, failure.handle.taskId], ['MODEL3D_TASK_FAILED', true, true, 'preview-4']);
    assert.deepEqual(sent(failing.calls), ['POST /v2/text-to-3d', 'GET /v2/text-to-3d/preview-4']);
});
