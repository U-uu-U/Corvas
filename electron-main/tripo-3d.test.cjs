const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspect } = require('node:util');
const { normalizeModel3dRequest } = require('./model3d-common.cjs');
const { generateModel3d, resumeModel3d } = require('./model3d-providers.cjs');
const { TRIPO, createTripoProvider, buildTripoGenerationBody, buildTripoConvertBody, tripoStatus, tripoSubmitKind } = require('./tripo-3d.cjs');

const KEY = 'tsk_unit_test_secret';
const GLOBAL = 'https://openapi.tripo3d.ai/v3';
const CN = 'https://openapi.tripo3d.com/v3';
const TASK = '123e4567-e89b-42d3-a456-426614174000';
const CONVERT_TASK = '987e6543-e21b-42d3-a456-426614174000';
const SIGNED_PUT = 'https://storage.example.com/bucket/path/input.webp?X-Amz-Signature=putsecret';
const SIGNED_MODEL = 'https://cdn.tripo3d.ai/output/model_pbr.glb?Signature=modelsecret';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-pixels-0123456789')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-pixels-0123456789')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('webp-pixels-0123456789')]);
const JSON_HEADERS = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const reply = (status, body, headers = {}) => ({ status, headers: new Headers(headers),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ok = data => reply(200, { code: 0, data });
const created = (taskId = TASK) => ok({ task_id: taskId });
const dropped = code => Object.assign(new Error('fetch failed'), { cause: { code } });

// Records every request and answers from the script. An Error entry is thrown, a function entry is
// called in place of the network; an unscripted request fails the test.
function fakeProvider(config, ...script) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body });
        if (!script.length) throw new Error(`unscripted request: ${init.method} ${url}`);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next() : next;
    };
    return { calls, provider: createTripoProvider({ apiKey: KEY, ...config, fetchImpl }) };
}
const fakeTripo = (...script) => fakeProvider({}, ...script);

function imageFiles(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tripo-3d-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const write = (name, data) => { const file = path.join(dir, name); fs.writeFileSync(file, data); return file; };
    return { dir, png: write('front.png', PNG), jpeg: write('back.jpg', JPEG), webp: write('side.webp', WEBP) };
}

const normalize = request => normalizeModel3dRequest(request, { ...TRIPO.limits, formats: TRIPO.formats }, 'Tripo');
const flags = error => [error.kind, error.confirmedFailure, error.submissionUnknown, error.retryable];
const failed = async promise => { try { await promise; } catch (error) { return error; } throw new Error('expected a rejection'); };
// The whole error as a log would print it: message, stack and every property.
const printed = error => inspect(error, { depth: 8 });
const succeeded = url => ({ status: 'success', progress: 100, output: { model_url: url } });
// The key travels in Authorization, and only to the API address the provider was created with.
const keyStaysOn = (calls, base) => calls.every(call => ('Authorization' in call.headers) === call.url.startsWith(`${base}/`));

const HANDLE = { provider: 'tripo', taskId: TASK, stage: 'generate', format: 'glb', next: null, history: [], baseUrl: GLOBAL, expectedFormat: 'glb' };
// A generation that still needs a convert task, and the status that allows it: finished, as GLB.
const OBJ_HANDLE = { ...HANDLE, format: 'obj', next: { stage: 'convert', body: { format: 'OBJ' } } };
const GLB_DONE = tripoStatus(succeeded(SIGNED_MODEL), OBJ_HANDLE);

test('info lists the documented regions, models and limits, and the factory never checks the key prefix', () => {
    assert.deepEqual([TRIPO.id, TRIPO.name, TRIPO.baseUrl, TRIPO.defaultModel], ['tripo', 'Tripo', GLOBAL, 'v3.1-20260211']);
    assert.deepEqual(TRIPO.regions, { global: GLOBAL, cn: CN });
    assert.deepEqual(TRIPO.modes, ['text', 'image', 'multiview']);
    assert.deepEqual(TRIPO.formats, ['glb', 'fbx', 'obj', 'usdz', 'stl', '3mf', 'gltf']);
    assert.deepEqual(TRIPO.models.map(model => model.id), ['v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123', 'P2-20260801', 'P1-20260311']);
    assert.ok(TRIPO.models.every(model => model.label));
    assert.deepEqual(TRIPO.limits, { promptMax: 1024, multiview: [2, 4], imageMaxBytes: 20 * 1024 * 1024, imageFormats: ['jpeg', 'png', 'webp'] });
    assert.deepEqual([TRIPO.maxWaitMs, TRIPO.supportsCancel, TRIPO.supportsImageUrl], [20 * 60 * 1000, false, true]);
    assert.ok(fs.existsSync(path.join(__dirname, '..', TRIPO.docs)));
    // Read-only all the way down: every provider object shares this one.
    const frozen = value => Object.isFrozen(value) && Object.values(value).every(item => item === null || typeof item !== 'object' || frozen(item));
    assert.ok(frozen(TRIPO));

    const provider = createTripoProvider({ apiKey: 'sk-another-prefix', fetchImpl: async () => reply(500, '') });
    assert.equal(provider.info, TRIPO);
    assert.deepEqual(Object.keys(provider).sort(), ['advance', 'balance', 'cancel', 'info', 'nextStage', 'pollDelayMs', 'query', 'submit']);
    assert.deepEqual([provider.pollDelayMs(0), provider.pollDelayMs(40, { state: 'running' })], [2000, 2000]);
    // A key fetch could not put in a header is refused up front, not when the paid request is sent.
    for (const apiKey of [undefined, '', 'tsk bad', 'tsk_pasted​', 'tsk_密钥']) {
        assert.throws(() => createTripoProvider({ apiKey }), { code: 'MODEL3D_AUTH_FAILED' });
    }
    assert.throws(() => createTripoProvider({ apiKey: KEY, region: 'mars' }), { code: 'MODEL3D_INVALID_REQUEST' });
    assert.throws(() => createTripoProvider({ apiKey: KEY, region: 'mars', baseUrl: 'https://relay.test/v3' }), { code: 'MODEL3D_INVALID_REQUEST' });
    // A name that only exists on Object.prototype is not a region either.
    assert.throws(() => createTripoProvider({ apiKey: KEY, region: 'toString' }), { code: 'MODEL3D_INVALID_REQUEST', message: /区域/ });
    assert.throws(() => createTripoProvider({ apiKey: KEY, baseUrl: 'http://openapi.tripo3d.ai/v3' }), { code: 'MODEL3D_INVALID_REQUEST' });
});

test('generation bodies map the unified fields and let them override providerOptions', () => {
    assert.deepEqual(buildTripoGenerationBody(normalize({ mode: 'text', prompt: ' a chair ' })),
        { model: 'v3.1-20260211', texture: true, pbr: true, prompt: 'a chair' });
    assert.deepEqual(buildTripoGenerationBody(normalize({ mode: 'image', image: 'https://cdn.test/a.png', model: 'P2-20260801', texture: false,
        topology: 'quad', targetFaces: 5000, seed: 7 }), ['file_abc123']),
    { model: 'P2-20260801', texture: false, pbr: false, quad: true, face_limit: 5000, model_seed: 7, input: 'file_abc123' });
    const flat = buildTripoGenerationBody(normalize({ mode: 'text', prompt: 'x', pbr: false }));
    assert.deepEqual([flat.texture, flat.pbr], [true, false]);

    const overridden = buildTripoGenerationBody(normalize({ mode: 'text', prompt: 'real', model: 'v3.0-20250812', topology: 'triangle',
        targetFaces: 80000, seed: 42, providerOptions: { model: 'v2.5-20250123', texture: false, pbr: false, quad: true, face_limit: 1,
            model_seed: 1, prompt: 'ignored', texture_quality: 'detailed', negative_prompt: 'blurry' } }));
    assert.deepEqual(overridden, { model: 'v3.0-20250812', texture: true, pbr: true, face_limit: 80000, model_seed: 42, prompt: 'real',
        texture_quality: 'detailed', negative_prompt: 'blurry' });
    // quad is only ever sent as true: an unset or triangle topology omits the key instead of sending false.
    assert.equal('quad' in buildTripoGenerationBody(normalize({ mode: 'text', prompt: 'x' })), false);
    const passthrough = buildTripoGenerationBody(normalize({ mode: 'text', prompt: 'x', providerOptions: { quad: true, face_limit: 9000, model_seed: 3 } }));
    assert.deepEqual([passthrough.quad, passthrough.face_limit, passthrough.model_seed], [true, 9000, 3]);
    // P1 rejects the key even when it is false, so a false from providerOptions is dropped as well.
    assert.equal('quad' in buildTripoGenerationBody(normalize({ mode: 'text', prompt: 'x', model: 'P1-20260311', providerOptions: { quad: false } })), false);

    const views = normalize({ mode: 'multiview', images: [{ source: 'b.png', view: 'back' }, 'f.png', { source: 'r.png', view: 'right' }] });
    assert.deepEqual(buildTripoGenerationBody(views, ['file_front', 'https://cdn.test/back.png', 'file_right']),
        { model: 'v3.1-20260211', texture: true, pbr: true,
            inputs: [{ front: 'file_front' }, { back: 'https://cdn.test/back.png' }, { right: 'file_right' }] });

    assert.deepEqual(buildTripoConvertBody('fbx'), { format: 'FBX' });
    // The format is the caller's unified field, and the input is always filled in by advance.
    assert.deepEqual(buildTripoConvertBody('3mf', { format: 'OBJ', input: SIGNED_MODEL, texture_size: 2048 }), { format: '3MF', texture_size: 2048 });
});

test('text generation sends one JSON request and returns a handle that survives JSON', async () => {
    const { calls, provider } = fakeTripo(created());
    const handle = await provider.submit({ mode: 'text', prompt: 'A cat wearing a spacesuit', seed: 11 });
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].url, calls[0].method], [`${GLOBAL}/generation/text-to-model`, 'POST']);
    assert.deepEqual(calls[0].headers, JSON_HEADERS);
    assert.deepEqual(JSON.parse(calls[0].body), { model: 'v3.1-20260211', texture: true, pbr: true, model_seed: 11, prompt: 'A cat wearing a spacesuit' });
    assert.deepEqual(handle, HANDLE);
    assert.deepEqual(JSON.parse(JSON.stringify(handle)), handle);
    assert.equal(JSON.stringify(handle).includes(KEY), false);
});

test('a local JPEG or PNG is uploaded through POST /files and referenced by its file_token', async t => {
    const files = imageFiles(t);
    const { calls, provider } = fakeTripo(ok({ file_token: 'file_abc123' }), created());
    const handle = await provider.submit({ mode: 'image', images: [files.png], texture: false, targetFaces: 30000, format: 'obj' });
    assert.equal(calls.length, 2);
    assert.ok(keyStaysOn(calls, GLOBAL));

    const upload = calls[0];
    assert.deepEqual([upload.url, upload.method], [`${GLOBAL}/files`, 'POST']);
    assert.deepEqual(Object.keys(upload.headers), ['Authorization', 'Content-Type']);
    assert.equal(upload.headers.Authorization, `Bearer ${KEY}`);
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(upload.headers['Content-Type'])[1];
    const form = upload.body.toString('latin1');
    assert.ok(form.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`));
    assert.ok(form.endsWith(`\r\n--${boundary}--\r\n`));
    assert.ok(upload.body.includes(PNG));

    assert.deepEqual([calls[1].url, calls[1].method], [`${GLOBAL}/generation/image-to-model`, 'POST']);
    assert.deepEqual(calls[1].headers, JSON_HEADERS);
    assert.deepEqual(JSON.parse(calls[1].body), { model: 'v3.1-20260211', texture: false, pbr: false, face_limit: 30000, input: 'file_abc123' });
    assert.deepEqual(handle, OBJ_HANDLE);
    const saved = JSON.stringify(handle);
    for (const secret of [KEY, PNG.toString('base64'), 'file_abc123', files.png, 'png-pixels']) assert.equal(saved.includes(secret), false);

    // The type comes from the bytes: a data URI and a mislabeled file both upload as what they really are.
    const jpeg = fakeTripo(ok({ file_token: 'file_jpeg' }), created());
    const fromDataUri = await jpeg.provider.submit({ mode: 'image', image: `data:image/png;base64,${JPEG.toString('base64')}` });
    assert.ok(jpeg.calls[0].body.toString('latin1').includes('filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'));
    assert.equal(JSON.parse(jpeg.calls[1].body).input, 'file_jpeg');
    assert.equal(jpeg.calls[1].body.includes(JPEG.toString('base64')), false);
    // Neither the data URI nor its bytes are kept: the handle is the same as for a text request.
    assert.deepEqual(fromDataUri, HANDLE);
});

test('a local WebP uses the presigned flow and the storage PUT carries no Authorization', async t => {
    const files = imageFiles(t);
    for (const urlKey of ['presigned_url', 'upload_url']) {
        const { calls, provider } = fakeTripo(ok({ [urlKey]: SIGNED_PUT, file_token: 'file_webp', expires_in: 1800 }), reply(200, ''), created());
        const handle = await provider.submit({ mode: 'image', images: [files.webp] });
        assert.equal(calls.length, 3);
        assert.ok(keyStaysOn(calls, GLOBAL));
        assert.deepEqual([calls[0].url, calls[0].method, calls[0].headers], [`${GLOBAL}/files/presign`, 'POST', JSON_HEADERS]);
        assert.deepEqual(JSON.parse(calls[0].body), { format: 'webp' });
        assert.deepEqual([calls[1].url, calls[1].method], [SIGNED_PUT, 'PUT']);
        assert.deepEqual(calls[1].headers, { 'Content-Type': 'application/octet-stream' });
        assert.deepEqual(Buffer.from(calls[1].body), WEBP);
        assert.equal(calls[2].url, `${GLOBAL}/generation/image-to-model`);
        assert.equal(JSON.parse(calls[2].body).input, 'file_webp');
        assert.deepEqual(handle, HANDLE);
    }
});

test('an image URL is passed through without an upload and is not kept in the handle', async () => {
    const { calls, provider } = fakeTripo(created());
    const signedInput = 'https://example.com/image.png?X-Amz-Signature=inputsecret';
    const handle = await provider.submit({ mode: 'image', images: [signedInput], model: 'P1-20260311', targetFaces: 3000 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${GLOBAL}/generation/image-to-model`);
    assert.deepEqual(JSON.parse(calls[0].body), { model: 'P1-20260311', texture: true, pbr: true, face_limit: 3000, input: signedInput });
    assert.deepEqual(handle, HANDLE);
});

test('multiview uploads local views in front-left-back-right order and sends view-key inputs', async t => {
    const files = imageFiles(t);
    const { calls, provider } = fakeTripo(ok({ file_token: 'file_front' }), ok({ file_token: 'file_back' }), created());
    const handle = await provider.submit({ mode: 'multiview', topology: 'quad', format: 'fbx',
        images: [{ source: files.jpeg, view: 'back' }, files.png, { source: 'https://example.com/right.png', view: 'right' }] });
    assert.deepEqual(calls.map(call => `${call.method} ${call.url}`),
        [`POST ${GLOBAL}/files`, `POST ${GLOBAL}/files`, `POST ${GLOBAL}/generation/multiview-to-model`]);
    assert.ok(keyStaysOn(calls, GLOBAL));
    assert.ok(calls[0].body.includes(PNG) && calls[0].body.toString('latin1').includes('filename="image.png"'));
    assert.ok(calls[1].body.includes(JPEG) && calls[1].body.toString('latin1').includes('filename="image.jpg"'));
    assert.deepEqual(calls[2].headers, JSON_HEADERS);
    assert.deepEqual(JSON.parse(calls[2].body), { model: 'v3.1-20260211', texture: true, pbr: true, quad: true,
        inputs: [{ front: 'file_front' }, { back: 'file_back' }, { right: 'https://example.com/right.png' }] });
    assert.deepEqual(handle, { ...HANDLE, format: 'fbx', expectedFormat: 'fbx', next: { stage: 'convert', body: { format: 'FBX' } } });
});

test('invalid requests and unreadable images fail locally without any request', async t => {
    const files = imageFiles(t);
    const gif = path.join(files.dir, 'anim.png');
    fs.writeFileSync(gif, 'GIF89a not a supported image');
    const huge = path.join(files.dir, 'huge.png');
    fs.writeFileSync(huge, PNG);
    fs.truncateSync(huge, TRIPO.limits.imageMaxBytes + 1);
    const cycle = {};
    cycle.self = cycle;
    const { calls, provider } = fakeTripo();
    for (const request of [{ mode: 'text' }, { mode: 'text', prompt: 'x'.repeat(1025) }, { mode: 'text', prompt: 'x', format: 'blend' },
        { mode: 'text', prompt: 'x', texture: false, pbr: true }, { mode: 'text', prompt: 'x', stageOptions: { convert: 'FBX' } },
        { mode: 'image', images: [gif] }, { mode: 'image', images: [path.join(files.dir, 'missing.png')] }, { mode: 'image', images: [huge] },
        { mode: 'multiview', images: [files.png] }, { mode: 'multiview', images: [{ source: files.png, view: 'left' }, { source: files.jpeg, view: 'back' }] },
        // A valid first view is not uploaded when a later one is unreadable.
        { mode: 'multiview', images: [files.png, gif] },
        // Options JSON cannot carry are the caller's mistake: nothing is uploaded, and the create request
        // is not reported as sent with an unknown outcome.
        { mode: 'text', prompt: 'x', providerOptions: { face_limit: 10n } }, { mode: 'image', images: [files.png], providerOptions: { cycle } },
        { mode: 'text', prompt: 'x', format: 'fbx', stageOptions: { convert: { texture_size: 10n } } }]) {
        const error = await failed(provider.submit(request));
        assert.deepEqual(flags(error), ['invalid', true, false, false], inspect(request));
    }
    assert.equal(calls.length, 0);
});

test('upload failures are reported before any task exists and never leak the signed URL', async t => {
    const files = imageFiles(t);
    const run = async (file, ...script) => {
        const fake = fakeTripo(...script);
        const error = await failed(fake.provider.submit({ mode: 'image', images: [file] }));
        assert.equal(fake.calls.some(call => call.url.includes('/generation/')), false);
        assert.equal(/tsk_unit|putsecret|storage\.example/.test(printed(error)), false);
        return { error, calls: fake.calls };
    };
    const busy = await run(files.png, reply(500, { code: 1000, message: 'unknown' }));
    assert.deepEqual([...flags(busy.error), busy.error.status, busy.calls.length], ['upload', true, false, true, 500, 1]);
    const limited = await run(files.png, reply(429, { code: 1007 }, { 'Retry-After': '6' }));
    assert.deepEqual([...flags(limited.error), limited.error.retryAfterMs], ['upload', true, false, true, 6000]);
    const unsupported = await run(files.png, reply(400, { code: 2004, message: 'unsupported file type' }));
    assert.deepEqual([...flags(unsupported.error), unsupported.error.remoteCode], ['upload', true, false, false, 2004]);
    assert.deepEqual(flags((await run(files.png, dropped('ECONNRESET'))).error), ['upload', true, false, true]);
    assert.deepEqual(flags((await run(files.png, new Error(`bad header Bearer ${KEY}`))).error), ['upload', true, false, true]);
    assert.deepEqual(flags((await run(files.png, ok({}))).error), ['upload', true, false, true]);
    assert.deepEqual(flags((await run(files.png, reply(200, { code: 1004, message: 'bad' }))).error), ['upload', true, false, false]);
    assert.deepEqual(flags((await run(files.png, reply(401, { code: 2, message: `Authentication required ${KEY}` }))).error), ['auth', true, false, false]);

    const storage = await run(files.webp, ok({ presigned_url: SIGNED_PUT, file_token: 'file_webp' }),
        reply(403, `<Error><Code>SignatureDoesNotMatch</Code><Url>${SIGNED_PUT}</Url></Error>`));
    assert.deepEqual([...flags(storage.error), storage.error.status, storage.calls.length], ['upload', true, false, true, 403, 2]);
    // Only a 2xx answer from storage means the bytes are there.
    const unchanged = await run(files.webp, ok({ presigned_url: SIGNED_PUT, file_token: 'file_webp' }), reply(304, ''));
    assert.deepEqual([unchanged.error.kind, unchanged.calls.length], ['upload', 2]);
    const cut = await run(files.webp, ok({ presigned_url: SIGNED_PUT, file_token: 'file_webp' }), new Error(`socket hang up ${SIGNED_PUT}`));
    assert.deepEqual([...flags(cut.error), cut.calls.length], ['upload', true, false, true, 2]);
    // Without an HTTPS address in the answer, nothing is sent to storage.
    for (const data of [{ file_token: 'file_webp' }, { presigned_url: 'http://storage.example.com/plain', file_token: 'file_webp' },
        { presigned_url: [SIGNED_PUT], file_token: 'file_webp' }]) {
        const missing = await run(files.webp, ok(data));
        assert.deepEqual([missing.error.kind, missing.calls.length], ['upload', 1]);
    }
    // The second view fails: the first upload is not followed by a create request either.
    const second = fakeTripo(ok({ file_token: 'file_front' }), reply(500, ''));
    const error = await failed(second.provider.submit({ mode: 'multiview', images: [files.png, files.jpeg] }));
    assert.deepEqual([error.kind, second.calls.map(call => call.url)], ['upload', [`${GLOBAL}/files`, `${GLOBAL}/files`]]);
});

test('every documented create failure maps to its kind, and each attempt sends exactly one request', async () => {
    const cases = [
        [reply(429, { code: 1007, message: 'rate limit' }), 'rateLimited', true, false, true],
        [reply(429, { code: 2000, message: 'You have exceeded the limit of generation' }, { 'Retry-After': '9' }), 'rateLimited', true, false, true],
        [reply(429, '<html>too many</html>'), 'rateLimited', true, false, true],
        [reply(503, { code: 1008 }, { 'Retry-After': '4' }), 'rateLimited', true, false, true],
        [reply(403, { code: 2010, message: 'You don\'t have enough credit to create this task' }), 'credits', true, false, false],
        [reply(200, { code: 2010, status: 'error' }), 'credits', true, false, false],
        // The body's code decides when it is one of the documented refusals, whatever status carries it.
        [reply(200, { code: 2000, message: 'You have exceeded the limit of generation' }), 'rateLimited', true, false, true],
        [reply(400, { code: 1007 }), 'rateLimited', true, false, true],
        [reply(403, { code: 2013, message: 'no access' }), 'forbidden', true, false, false],
        [reply(400, { code: 2008, message: 'content policy' }), 'content', true, false, false],
        [reply(401, { code: 2, message: 'Authentication required' }), 'auth', true, false, false],
        [reply(401, { code: 1002 }), 'auth', true, false, false],
        ...[1003, 1004, 2002, 2003, 2004, 2015, 2018].map(code => [reply(400, { code, message: 'bad request' }), 'rejected', true, false, false]),
        [reply(404, { code: 4001 }), 'rejected', true, false, false],
        [reply(408, ''), 'submissionUnknown', false, true, false],
        [reply(425, { code: 2010 }), 'submissionUnknown', false, true, false],
        [reply(500, { code: 1000 }), 'submissionUnknown', false, true, false],
        [reply(500, { code: 1001 }), 'submissionUnknown', false, true, false],
        [reply(500, { code: 2010 }), 'submissionUnknown', false, true, false],
        [reply(502, '<html>bad gateway</html>'), 'submissionUnknown', false, true, false],
        // Without Retry-After a 503 may come from a gateway in front of a service that did take the request.
        [reply(503, { code: 1008 }), 'submissionUnknown', false, true, false],
        [reply(503, '<html>upstream connect error</html>'), 'submissionUnknown', false, true, false],
        [reply(504, ''), 'submissionUnknown', false, true, false],
        [reply(200, { code: 1004, message: 'undocumented pairing' }), 'submissionUnknown', false, true, false],
        [reply(200, 'not json'), 'submissionUnknown', false, true, false],
        [reply(200, '[]'), 'submissionUnknown', false, true, false],
        [reply(204, ''), 'submissionUnknown', false, true, false],
        // A success body under a failing status contradicts itself: the task may exist, whatever the status says.
        [reply(400, { code: 0, data: { task_id: TASK } }), 'submissionUnknown', false, true, false],
        [reply(302, { code: 0, data: { task_id: TASK } }), 'submissionUnknown', false, true, false],
        [reply(429, { code: 0, data: { task_id: TASK } }), 'submissionUnknown', false, true, false],
        [reply(500, { code: 0, data: { task_id: TASK } }), 'submissionUnknown', false, true, false],
        [dropped('ECONNRESET'), 'submissionUnknown', false, true, false],
        [new Error('socket hang up'), 'submissionUnknown', false, true, false],
        [new Error(`cannot send header Authorization: Bearer ${KEY}`), 'submissionUnknown', false, true, false],
        [dropped('ECONNREFUSED'), 'network', true, false, true],
        [dropped('ENOTFOUND'), 'network', true, false, true],
        [ok({}), 'invalidResponse', false, true, false],
        [ok(null), 'invalidResponse', false, true, false],
        [reply(200, { code: 0 }), 'invalidResponse', false, true, false],
        [ok({ task_id: 42 }), 'invalidResponse', false, true, false],
        [ok({ task_id: '' }), 'invalidResponse', false, true, false]
    ];
    for (const [response, ...expected] of cases) {
        const { calls, provider } = fakeTripo(response);
        const error = await failed(provider.submit({ mode: 'text', prompt: 'a chair' }));
        const label = response instanceof Error ? `${response.message} ${response.cause?.code}` : `${response.status} ${await response.text()}`;
        assert.deepEqual(flags(error), expected, label);
        assert.equal(calls.length, 1, label);
        assert.equal(error.provider, 'Tripo');
        assert.equal(printed(error).includes(KEY), false, label);
    }

    const limited = await failed(fakeTripo(reply(429, { code: 2000 }, { 'Retry-After': '9' })).provider.submit({ mode: 'text', prompt: 'x' }));
    assert.deepEqual([limited.code, limited.status, limited.remoteCode, limited.retryAfterMs], ['MODEL3D_RATE_LIMITED', 429, 2000, 9000]);
    const echoed = await failed(fakeTripo(reply(400, { code: 1004, message: `invalid parameter near ${KEY}` })).provider.submit({ mode: 'text', prompt: 'x' }));
    assert.match(echoed.message, /HTTP 400 code 1004 invalid parameter/);
    assert.equal(printed(echoed).includes(KEY), false);
    // Error properties are not redacted, so a code that is not the documented integer is not copied into one.
    const oddCode = await failed(fakeTripo(reply(400, { code: `E-${KEY}`, message: 'bad' })).provider.submit({ mode: 'text', prompt: 'x' }));
    assert.deepEqual([...flags(oddCode), oddCode.remoteCode, printed(oddCode).includes(KEY)], ['rejected', true, false, false, null, false]);

    assert.deepEqual([tripoSubmitKind(429, 1007), tripoSubmitKind(429, undefined), tripoSubmitKind(503, 1008, 4000), tripoSubmitKind(503, 1008, 0),
        tripoSubmitKind(503, 1008), tripoSubmitKind(503, 1007), tripoSubmitKind(403, 2010), tripoSubmitKind(400, 2008), tripoSubmitKind(500, 2010),
        tripoSubmitKind(400, 1004), tripoSubmitKind(400, 'constructor'), tripoSubmitKind(408, undefined), tripoSubmitKind(425, 1004),
        tripoSubmitKind(200, 2000), tripoSubmitKind(400, 1007), tripoSubmitKind(400, 0), tripoSubmitKind(429, 0)],
    ['rateLimited', 'rateLimited', 'rateLimited', 'rateLimited', undefined, undefined, 'credits', 'content', undefined, undefined, undefined,
        'submissionUnknown', 'submissionUnknown', 'rateLimited', 'rateLimited', 'submissionUnknown', 'submissionUnknown']);
});

test('a create request that times out is sent once and reported as submission unknown', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const calls = [];
    let reached;
    const sent = new Promise(resolve => { reached = resolve; });
    const provider = createTripoProvider({ apiKey: KEY, fetchImpl: (url, init) => {
        calls.push(url);
        reached();
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    } });
    const pending = failed(provider.submit({ mode: 'text', prompt: 'a chair' }));
    await sent;
    t.mock.timers.tick(30000);
    const error = await pending;
    assert.deepEqual(flags(error), ['submissionUnknown', false, true, false]);
    assert.match(error.message, /请求超时/);
    assert.deepEqual(calls, [`${GLOBAL}/generation/text-to-model`]);
});

test('an upload gets two minutes, then fails as an upload and is not followed by a create request', async t => {
    const files = imageFiles(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const presigned = ok({ presigned_url: SIGNED_PUT, file_token: 'file_webp' });
    for (const [file, answered, stuck] of [[files.png, [], `${GLOBAL}/files`], [files.webp, [presigned], SIGNED_PUT]]) {
        const calls = [];
        let reached;
        const sent = new Promise(resolve => { reached = resolve; });
        const provider = createTripoProvider({ apiKey: KEY, fetchImpl: async (url, init) => {
            calls.push(url);
            if (answered.length) return answered.shift();
            reached();
            return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(`aborted ${url}`))));
        } });
        let error = null;
        const pending = provider.submit({ mode: 'image', images: [file] }).catch(caught => { error = caught; });
        await sent;
        // Longer than the 30 seconds a JSON request gets: a large image on a slow line is still uploading.
        t.mock.timers.tick(2 * 60 * 1000 - 1);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(error, null, stuck);
        t.mock.timers.tick(1);
        await pending;
        assert.deepEqual([...flags(error), calls.at(-1)], ['upload', true, false, true, stuck]);
        assert.match(error.message, /上传超时/);
        assert.equal(/putsecret|storage\.example/.test(printed(error)), false);
    }
});

test('an abort ends every call as an abort, never as a provider failure', async t => {
    const files = imageFiles(t);
    const aborted = new AbortController();
    aborted.abort();
    const idle = fakeTripo();
    // Already aborted: nothing is read or sent, even for a request whose image does not exist.
    const before = [];
    for (const request of [{ mode: 'text', prompt: 'a chair' }, { mode: 'image', images: [path.join(files.dir, 'missing.png')] }]) {
        before.push(await failed(idle.provider.submit(request, { signal: aborted.signal })));
    }
    before.push(await failed(idle.provider.query(HANDLE, { signal: aborted.signal })));
    before.push(await failed(idle.provider.advance(OBJ_HANDLE, GLB_DONE, { signal: aborted.signal })));
    before.push(await failed(idle.provider.balance({ signal: aborted.signal })));
    // Nothing was sent, so none of these may claim that a task could exist.
    for (const error of before) assert.deepEqual([error.name, error.code, error.kind, error.submissionUnknown], ['AbortError', 'GENERATION_CANCELED', undefined, undefined]);
    assert.equal(idle.calls.length, 0);

    // Aborted while the last scripted request is in flight. The error stays an abort: it is not turned into
    // an upload failure, an unknown submission or an unavailable status, and nothing else is sent.
    // Only an interrupted create request is flagged: its task may exist and be billed.
    const midFlight = async (run, ...earlier) => {
        const controller = new AbortController();
        const fake = fakeTripo(...earlier, () => { controller.abort(); throw new Error('This operation was aborted'); });
        const error = await failed(run(fake.provider, controller.signal));
        assert.deepEqual([error.name, error.code, error.kind], ['AbortError', 'GENERATION_CANCELED', undefined]);
        assert.equal(fake.calls.length, earlier.length + 1);
        return [fake.calls.at(-1).url, error.submissionUnknown];
    };
    const presigned = ok({ presigned_url: SIGNED_PUT, file_token: 'file_webp' });
    assert.deepEqual([
        await midFlight((provider, signal) => provider.submit({ mode: 'text', prompt: 'x' }, { signal })),
        await midFlight((provider, signal) => provider.submit({ mode: 'image', images: [files.png] }, { signal })),
        await midFlight((provider, signal) => provider.submit({ mode: 'image', images: [files.webp] }, { signal })),
        await midFlight((provider, signal) => provider.submit({ mode: 'image', images: [files.webp] }, { signal }), presigned),
        await midFlight((provider, signal) => provider.submit({ mode: 'image', images: [files.png] }, { signal }), ok({ file_token: 'file_abc123' })),
        await midFlight((provider, signal) => provider.query(HANDLE, { signal })),
        await midFlight((provider, signal) => provider.advance(OBJ_HANDLE, GLB_DONE, { signal })),
        await midFlight((provider, signal) => provider.balance({ signal }))
    ], [[`${GLOBAL}/generation/text-to-model`, true], [`${GLOBAL}/files`, undefined], [`${GLOBAL}/files/presign`, undefined], [SIGNED_PUT, undefined],
        [`${GLOBAL}/generation/image-to-model`, true], [`${GLOBAL}/tasks/${TASK}`, undefined], [`${GLOBAL}/models/convert`, true],
        [`${GLOBAL}/account/balance`, undefined]]);

    // Aborted between an upload and the create request: the create request is not sent, so nothing is flagged.
    const between = new AbortController();
    const uploaded = fakeTripo(() => { between.abort(); return ok({ file_token: 'file_abc123' }); });
    const unsent = await failed(uploaded.provider.submit({ mode: 'image', images: [files.png] }, { signal: between.signal }));
    assert.deepEqual([unsent.name, unsent.submissionUnknown, uploaded.calls.map(call => call.url)], ['AbortError', undefined, [`${GLOBAL}/files`]]);

    // Aborted after the answer arrived: the task exists, so its id is returned and not thrown away.
    for (const run of [(provider, signal) => provider.submit({ mode: 'text', prompt: 'x' }, { signal }),
        (provider, signal) => provider.advance(OBJ_HANDLE, GLB_DONE, { signal })]) {
        const late = new AbortController();
        const answered = fakeTripo(() => { late.abort(); return created(CONVERT_TASK); });
        assert.equal((await run(answered.provider, late.signal)).taskId, CONVERT_TASK);
    }
});

test('every task status maps to one state and unknown values keep polling', () => {
    const states = { queued: 'queued', running: 'running', success: 'succeeded', failed: 'failed', banned: 'failed', expired: 'failed',
        cancelled: 'canceled', unknown: 'unknown', paused: 'unknown', constructor: 'unknown', '': 'unknown' };
    for (const [status, state] of Object.entries(states)) {
        const mapped = tripoStatus({ status, progress: 40 });
        assert.deepEqual([mapped.state, mapped.remoteStatus], [state, status], status);
    }
    assert.deepEqual(tripoStatus({ task_id: TASK, type: 'text_to_model', status: 'running', progress: 60 }),
        { state: 'running', progress: 60, remoteStatus: 'running', outputs: [], error: null, creditsConsumed: null, expiresAt: null, retryAfterMs: null });
    assert.deepEqual([tripoStatus({ status: 'queued' }).progress, tripoStatus({ status: 'running', progress: 250 }).progress,
        tripoStatus({ status: 'running', progress: -5 }).progress, tripoStatus({ status: 'running', progress: 'half' }).progress,
        tripoStatus({ status: 'success' }).progress, tripoStatus({ status: 'failed' }).progress], [null, 100, 0, null, 100, null]);
    for (const empty of [undefined, null, [], 'success']) assert.equal(tripoStatus(empty).state, 'unknown');
    // Output is only read from a finished task.
    assert.deepEqual(tripoStatus({ status: 'running', output: { model_url: SIGNED_MODEL } }).outputs, []);
});

test('finished tasks list the model first, then the preview, with the real file format', () => {
    const done = tripoStatus({ status: 'success', progress: 100, credits_consumed: 30.5,
        output: { rendered_image_url: 'https://cdn.tripo3d.ai/output/preview.webp?Signature=p', model_url: SIGNED_MODEL } }, { expectedFormat: 'glb' });
    assert.deepEqual(done.outputs, [{ role: 'model', format: 'glb', url: SIGNED_MODEL, name: null },
        { role: 'thumbnail', format: 'webp', url: 'https://cdn.tripo3d.ai/output/preview.webp?Signature=p', name: null }]);
    assert.deepEqual([done.state, done.error, done.creditsConsumed], ['succeeded', null, 30.5]);

    const format = (url, handle) => tripoStatus(succeeded(url), handle).outputs[0].format;
    assert.equal(format('https://cdn.tripo3d.ai/output/converted-model', { expectedFormat: 'usdz' }), 'usdz');
    assert.equal(format('https://cdn.tripo3d.ai/output/quad.fbx?x=1', { expectedFormat: 'glb' }), 'fbx');
    assert.equal(format('https://cdn.tripo3d.ai/output/model.bin', { expectedFormat: 'obj' }), 'obj');
    assert.equal(format('https://cdn.tripo3d.ai/output/packed.zip', { expectedFormat: 'fbx' }), 'zip');
    assert.equal(format('https://cdn.tripo3d.ai/output/converted-model'), 'glb');
    // Whatever a saved record says about the format, the file of a finished task is listed as the model.
    assert.equal(tripoStatus(succeeded('https://cdn.tripo3d.ai/output/converted-model'), { expectedFormat: 'bin' }).outputs[0].role, 'model');
    assert.deepEqual(tripoStatus({ status: 'success', output: { riggable: true } }).outputs, []);
    assert.equal(tripoStatus({ status: 'success', credits_consumed: 0 }).creditsConsumed, 0);
});

test('task errors keep the provider code and mark only timeouts as worth a new task', () => {
    const error = data => tripoStatus(data).error;
    assert.deepEqual(error({ status: 'failed', error_code: 2008, error_message: 'Content policy violation' }),
        { code: 2008, message: '内容未通过审核', retryable: false });
    assert.deepEqual(error({ status: 'banned' }), { code: null, message: '内容未通过审核', retryable: false });
    assert.deepEqual(error({ status: 'failed', error_code: 2018, error_message: 'Task processing timeout' }),
        { code: 2018, message: 'Task processing timeout', retryable: true });
    assert.deepEqual(error({ status: 'expired' }), { code: null, message: '任务超时', retryable: true });
    assert.deepEqual(error({ status: 'failed', error_code: 1234, error_message: 'mesh generation failed' }),
        { code: 1234, message: 'mesh generation failed', retryable: false });
    assert.deepEqual(error({ status: 'failed' }), { code: null, message: '任务失败', retryable: false });
    // The SDKs read error_msg as well; the documented key wins when both are present.
    assert.equal(error({ status: 'failed', error_msg: 'legacy key' }).message, 'legacy key');
    assert.equal(error({ status: 'failed', error_message: 'documented key', error_msg: 'legacy key' }).message, 'documented key');
    // A provider message is shown to the user, so it is flattened to one line and cut.
    assert.equal(error({ status: 'failed', error_message: `line one\r\n\tline two ${'x'.repeat(400)}` }).message, `line one line two ${'x'.repeat(282)}`);
    assert.equal(error({ status: 'cancelled', error_message: 'user cancelled' }), null);
    assert.equal(error({ status: 'success', error_code: 2018 }), null);
});

test('a task is only read and advanced on the API address that created it', async () => {
    const handle = { ...HANDLE, baseUrl: CN };
    const { calls, provider } = fakeProvider({ region: 'cn' }, ok({ task_id: TASK, type: 'text_to_model', status: 'success', progress: 100,
        credits_consumed: 20, output: { model_url: SIGNED_MODEL, rendered_image_url: 'https://cdn.tripo3d.ai/output/preview.png' } }),
    ok({ status: 'queued', progress: 0 }));
    const status = await provider.query(JSON.parse(JSON.stringify(handle)));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { url: `${CN}/tasks/${TASK}`, method: 'GET', headers: { Authorization: `Bearer ${KEY}` }, body: undefined });
    assert.deepEqual([status.state, status.progress, status.creditsConsumed, status.outputs.map(output => output.role)],
        ['succeeded', 100, 20, ['model', 'thumbnail']]);

    assert.equal((await provider.query({ ...handle, taskId: 'a/b c' })).state, 'queued');
    assert.equal(calls[1].url, `${CN}/tasks/a%2Fb%20c`);

    // A key is valid in one region only, and an edited handle must not send it anywhere else: a handle
    // from the other region, from another address or without an address is refused before any request.
    const convert = { ...OBJ_HANDLE, baseUrl: CN };
    for (const change of [{ baseUrl: GLOBAL }, { baseUrl: 'https://evil.test/v3' }, { baseUrl: undefined }, { provider: 'meshy' },
        { taskId: '' }, { taskId: 42 }]) {
        const error = await failed(provider.query({ ...handle, ...change }));
        // Not a confirmed failure: the record is unusable here, but its task may still be running.
        assert.deepEqual([error.code, error.confirmedFailure, error.submissionUnknown, error.message.includes('evil.test')],
            ['MODEL3D_INVALID_REQUEST', false, false, false], inspect(change));
        await assert.rejects(provider.advance({ ...convert, ...change }, GLB_DONE), { code: 'MODEL3D_INVALID_REQUEST' });
    }
    await assert.rejects(provider.query(null), { code: 'MODEL3D_INVALID_REQUEST' });
    await assert.rejects(provider.advance(null, GLB_DONE), { code: 'MODEL3D_INVALID_REQUEST' });
    assert.equal(calls.length, 2);
});

test('region and baseUrl choose the API address and the handle remembers it', async () => {
    const cn = fakeProvider({ region: 'cn' }, created());
    const handle = await cn.provider.submit({ mode: 'text', prompt: 'x' });
    assert.deepEqual([cn.calls.map(call => call.url), handle.baseUrl], [[`${CN}/generation/text-to-model`], CN]);

    const relay = 'https://relay.test/tripo/v3';
    const relayed = fakeProvider({ region: 'cn', baseUrl: `${relay}/` }, created(), ok({ status: 'running', progress: 5 }));
    const relayHandle = await relayed.provider.submit({ mode: 'text', prompt: 'x' });
    assert.equal(relayHandle.baseUrl, relay);
    assert.equal((await relayed.provider.query(relayHandle)).state, 'running');
    assert.deepEqual(relayed.calls.map(call => call.url), [`${relay}/generation/text-to-model`, `${relay}/tasks/${TASK}`]);
    assert.ok(keyStaysOn(relayed.calls, relay));
    // The relay's key is not sent to the official address for a task that was created there.
    await assert.rejects(relayed.provider.query(HANDLE), { code: 'MODEL3D_INVALID_REQUEST' });
    assert.equal(relayed.calls.length, 2);
});

test('query failures are transient only for network errors, 429 and 5xx, and never a confirmed failure', async () => {
    const cases = [
        [reply(404, { code: 2001, message: 'task not found' }), 'taskNotFound', undefined],
        [reply(401, { code: 2, message: 'Authentication required' }), 'auth', undefined],
        [reply(429, { code: 1007 }, { 'Retry-After': '3' }), 'statusUnavailable', true],
        [reply(500, { code: 1000 }), 'statusUnavailable', true],
        [reply(502, '<html>bad gateway</html>'), 'statusUnavailable', true],
        [reply(503, ''), 'statusUnavailable', true],
        [dropped('ECONNRESET'), 'statusUnavailable', true],
        [new Error(`cannot send header Authorization: Bearer ${KEY}`), 'statusUnavailable', true],
        [reply(400, { code: 1004 }), 'statusUnavailable', false],
        [reply(200, 'not json'), 'statusUnavailable', false],
        [reply(200, { code: 1000, message: `oops ${KEY}` }), 'statusUnavailable', false]
    ];
    for (const [response, kind, transient] of cases) {
        const { calls, provider } = fakeTripo(response);
        const error = await failed(provider.query(HANDLE));
        assert.deepEqual([error.kind, error.transient, error.confirmedFailure, error.submissionUnknown, calls.length], [kind, transient, false, false, 1], kind);
        assert.equal(printed(error).includes(KEY), false);
    }
    const limited = await failed(fakeTripo(reply(429, { code: 1007 }, { 'Retry-After': '3' })).provider.query(HANDLE));
    assert.deepEqual([limited.retryAfterMs, limited.remoteCode], [3000, 1007]);
    // A readable answer without a task object is not a failure either: the state is unknown and polling goes on.
    assert.equal((await fakeTripo(ok(null)).provider.query(HANDLE)).state, 'unknown');
});

test('nextStage converts only when the finished file is not the requested format, without any request', async () => {
    const fakes = [];
    const submit = async request => {
        const fake = fakeTripo(created());
        fakes.push(fake);
        return { handle: await fake.provider.submit({ mode: 'text', prompt: 'x', ...request }), provider: fake.provider };
    };
    const next = (handle, provider, url) => provider.nextStage(handle, tripoStatus(succeeded(url), handle));
    const bare = 'https://cdn.tripo3d.ai/output/model';

    const glb = await submit({});
    assert.equal(next(glb.handle, glb.provider, SIGNED_MODEL), null);
    const fbx = await submit({ format: 'fbx' });
    assert.deepEqual(next(fbx.handle, fbx.provider, SIGNED_MODEL), { stage: 'convert' });
    assert.deepEqual(next(fbx.handle, fbx.provider, bare), { stage: 'convert' });
    assert.equal(next(fbx.handle, fbx.provider, 'https://cdn.tripo3d.ai/output/model.fbx'), null);
    // Only a finished task with a model file can need another stage.
    const glbOutputs = tripoStatus(succeeded(SIGNED_MODEL), fbx.handle).outputs;
    for (const status of [undefined, {}, { state: 'succeeded', outputs: [] }, { state: 'running', outputs: glbOutputs },
        { state: 'failed', outputs: glbOutputs }, tripoStatus({ status: 'running', progress: 99 })]) {
        assert.equal(fbx.provider.nextStage(fbx.handle, status), null);
    }
    assert.equal(fbx.provider.nextStage(null, { state: 'succeeded', outputs: glbOutputs }), null);

    // quad on an H-series model already returns FBX, so asking for FBX needs no second task.
    const quad = await submit({ format: 'fbx', topology: 'quad' });
    assert.equal(quad.handle.expectedFormat, 'fbx');
    assert.equal(next(quad.handle, quad.provider, bare), null);
    assert.equal(next(quad.handle, quad.provider, 'https://cdn.tripo3d.ai/output/quad.fbx'), null);
    assert.deepEqual(next(quad.handle, quad.provider, SIGNED_MODEL), { stage: 'convert' });
    const quadObj = await submit({ format: 'obj', topology: 'quad' });
    assert.deepEqual(next(quadObj.handle, quadObj.provider, bare), { stage: 'convert' });

    // The docs do not say what P2 returns for quad, so only the URL can prove it is already FBX.
    const p2 = await submit({ format: 'fbx', topology: 'quad', model: 'P2-20260801' });
    assert.equal(p2.handle.expectedFormat, 'glb');
    assert.deepEqual(next(p2.handle, p2.provider, bare), { stage: 'convert' });
    assert.equal(next(p2.handle, p2.provider, 'https://cdn.tripo3d.ai/output/quad.fbx'), null);

    // GLB never converts, even when quad made the provider return FBX; the outputs then show the real format.
    const quadGlb = await submit({ topology: 'quad' });
    const status = tripoStatus(succeeded(bare), quadGlb.handle);
    assert.deepEqual([quadGlb.handle.next, quadGlb.provider.nextStage(quadGlb.handle, status), status.outputs[0].format], [null, null, 'fbx']);

    // Each fake answered its one create request and nothing else.
    assert.deepEqual(fakes.map(fake => fake.calls.length), fakes.map(() => 1));
});

test('advance submits one convert task for the generation task and returns the convert handle', async () => {
    const first = fakeTripo(created());
    // What is stored is plain JSON data without the caller's `input`, so a saved handle equals the live one.
    const handle = await first.provider.submit({ mode: 'text', prompt: 'x', format: 'fbx',
        stageOptions: { convert: { format: 'OBJ', input: SIGNED_MODEL, texture_size: 2048, fbx_preset: 'blender', pack_uv: undefined } } });
    assert.deepEqual(handle.next, { stage: 'convert', body: { format: 'FBX', texture_size: 2048, fbx_preset: 'blender' } });
    const saved = JSON.parse(JSON.stringify(handle));
    assert.deepEqual(saved, handle);
    assert.equal(/tsk_unit|Signature/.test(JSON.stringify(handle)), false);

    // After a restart: a new provider object and the saved record are all that is left of the first run.
    const { calls, provider } = fakeTripo(created(CONVERT_TASK),
        ok({ status: 'success', output: { model_url: 'https://cdn.tripo3d.ai/output/converted-model?Signature=s' } }));
    const converted = await provider.advance(saved, tripoStatus(succeeded(SIGNED_MODEL), saved));
    assert.equal(first.calls.length + calls.length, 2);
    assert.ok(keyStaysOn(calls, GLOBAL));
    assert.deepEqual([calls[0].url, calls[0].method, calls[0].headers], [`${GLOBAL}/models/convert`, 'POST', JSON_HEADERS]);
    assert.deepEqual(JSON.parse(calls[0].body), { format: 'FBX', input: TASK, texture_size: 2048, fbx_preset: 'blender' });
    assert.deepEqual(converted, { provider: 'tripo', taskId: CONVERT_TASK, stage: 'convert', format: 'fbx', next: null,
        history: [{ stage: 'generate', taskId: TASK }], baseUrl: GLOBAL, expectedFormat: 'fbx' });
    assert.deepEqual(JSON.parse(JSON.stringify(converted)), converted);
    assert.equal(/tsk_unit|Signature/.test(JSON.stringify(converted)), false);

    const status = await provider.query(converted);
    assert.equal(calls[1].url, `${GLOBAL}/tasks/${CONVERT_TASK}`);
    assert.deepEqual([status.outputs[0].role, status.outputs[0].format, provider.nextStage(converted, status)], ['model', 'fbx', null]);
    await assert.rejects(provider.advance(converted, status), { code: 'MODEL3D_INVALID_REQUEST' });
    assert.equal(calls.length, 2);

    // The convert task is created in the region of the generation task, and zip packaging changes the file type.
    // Its input is always the generation task, whatever an edited record says.
    const cn = fakeProvider({ region: 'cn' }, created(CONVERT_TASK));
    const zipped = await cn.provider.advance({ ...saved, baseUrl: CN,
        next: { stage: 'convert', body: { format: 'FBX', texture_packaging: 'zip', input: 'https://evil.test/model.glb' } } }, GLB_DONE);
    assert.deepEqual([cn.calls.map(call => call.url), zipped.baseUrl, zipped.expectedFormat], [[`${CN}/models/convert`], CN, 'zip']);
    assert.deepEqual(JSON.parse(cn.calls[0].body), { format: 'FBX', texture_packaging: 'zip', input: TASK });
    // quad forces FBX on a convert task as well.
    const quad = await fakeTripo(created(CONVERT_TASK)).provider.advance({ ...OBJ_HANDLE, next: { stage: 'convert', body: { format: 'OBJ', quad: true } } }, GLB_DONE);
    assert.equal(quad.expectedFormat, 'fbx');
});

test('a damaged history in a saved record does not lose the convert task that was just created', async () => {
    for (const history of [undefined, null, {}, 'generate', 7]) {
        const { calls, provider } = fakeTripo(created(CONVERT_TASK));
        const converted = await provider.advance({ ...OBJ_HANDLE, history }, GLB_DONE);
        assert.deepEqual([converted.taskId, converted.history, calls.length], [CONVERT_TASK, [{ stage: 'generate', taskId: TASK }], 1], inspect(history));
    }
    const earlier = [{ stage: 'import', taskId: 'earlier-task' }];
    const kept = await fakeTripo(created(CONVERT_TASK)).provider.advance({ ...OBJ_HANDLE, history: earlier }, GLB_DONE);
    assert.deepEqual(kept.history, [...earlier, { stage: 'generate', taskId: TASK }]);
});

test('advance never creates a convert task unless a finished model is in another format', async () => {
    const { calls, provider } = fakeTripo();
    const refused = async (handle, status) => {
        const error = await failed(provider.advance(handle, status));
        assert.deepEqual(flags(error), ['invalid', true, false, false], inspect({ handle, status }));
    };
    for (const status of [undefined, {}, tripoStatus({ status: 'queued' }), tripoStatus({ status: 'running', progress: 99 }),
        tripoStatus({ status: 'failed', error_code: 2018 }), tripoStatus({ status: 'unknown' }), tripoStatus({ status: 'success' }),
        { ...GLB_DONE, state: 'running' }, tripoStatus(succeeded('https://cdn.tripo3d.ai/output/model.obj'), OBJ_HANDLE)]) {
        await refused(OBJ_HANDLE, status);
    }
    // The last body cannot be written as JSON: refused as invalid before sending, not reported as a request with an unknown outcome.
    for (const next of [null, { stage: 'refine', body: { format: 'OBJ' } }, { stage: 'convert', body: 'OBJ' }, { stage: 'convert' },
        { stage: 'convert', body: { format: 'OBJ', face_limit: 10n } }]) {
        await refused({ ...OBJ_HANDLE, next }, GLB_DONE);
    }
    assert.equal(calls.length, 0);
});

test('a failed convert submission follows the same create rules and is never repeated', async () => {
    const cases = [
        [reply(500, { code: 1000 }), 'submissionUnknown', false, true, false],
        [reply(503, { code: 1008 }), 'submissionUnknown', false, true, false],
        [reply(200, 'not json'), 'submissionUnknown', false, true, false],
        [dropped('ECONNRESET'), 'submissionUnknown', false, true, false],
        [new Error(`cannot send header Authorization: Bearer ${KEY}`), 'submissionUnknown', false, true, false],
        [ok({}), 'invalidResponse', false, true, false],
        [dropped('ECONNREFUSED'), 'network', true, false, true],
        [reply(429, { code: 2000 }, { 'Retry-After': '2' }), 'rateLimited', true, false, true],
        [reply(403, { code: 2010 }), 'credits', true, false, false],
        [reply(400, { code: 1004 }), 'rejected', true, false, false]
    ];
    for (const [response, ...expected] of cases) {
        const { calls, provider } = fakeTripo(response);
        const error = await failed(provider.advance(OBJ_HANDLE, GLB_DONE));
        assert.deepEqual([...flags(error), calls.length, printed(error).includes(KEY)], [...expected, 1, false]);
    }
});

test('through the shared entry point each stage is created once, and an unknown convert outcome blocks a resume', async () => {
    const records = [];
    const options = { wait: async () => {}, onHandle: handle => { records.push(JSON.parse(JSON.stringify(handle))); } };
    const request = { mode: 'text', prompt: 'x', format: 'obj' };
    const sent = fake => fake.calls.map(call => `${call.method} ${call.url.slice(GLOBAL.length)}`);
    const objDone = ok(succeeded('https://cdn.tripo3d.ai/output/converted-model?Signature=s'));

    const whole = fakeTripo(created(), ok({ status: 'running', progress: 40 }), ok(succeeded(SIGNED_MODEL)), created(CONVERT_TASK), objDone);
    const result = await generateModel3d({ provider: whole.provider, request, ...options });
    assert.deepEqual(sent(whole), ['POST /generation/text-to-model', `GET /tasks/${TASK}`, `GET /tasks/${TASK}`, 'POST /models/convert',
        `GET /tasks/${CONVERT_TASK}`]);
    assert.deepEqual([result.handle.taskId, result.handle.history, result.primary.format], [CONVERT_TASK, [{ stage: 'generate', taskId: TASK }], 'obj']);
    assert.deepEqual(records.splice(0).map(record => [record.taskId, record.advancing]), [[TASK, undefined], [TASK, 'convert'], [CONVERT_TASK, undefined]]);

    // The convert request is answered by a gateway error: the task may exist, and the saved record says so.
    const broken = fakeTripo(created(), ok(succeeded(SIGNED_MODEL)), reply(502, '<html>bad gateway</html>'));
    const unknown = await failed(generateModel3d({ provider: broken.provider, request, ...options }));
    assert.deepEqual([...flags(unknown), unknown.stage, unknown.handle.advancing], ['submissionUnknown', false, true, false, 'convert', 'convert']);
    assert.deepEqual(sent(broken), ['POST /generation/text-to-model', `GET /tasks/${TASK}`, 'POST /models/convert']);
    assert.deepEqual(records.map(record => [record.taskId, record.advancing]), [[TASK, undefined], [TASK, 'convert']]);
    // After a restart that record is refused before any request, so the convert task cannot be paid for twice.
    const restarted = fakeTripo();
    const blocked = await failed(resumeModel3d({ provider: restarted.provider, handle: records.at(-1), ...options }));
    assert.deepEqual([...flags(blocked), restarted.calls.length], ['submissionUnknown', false, true, false, 0]);

    // A definite refusal proves that no convert task exists: the record is saved without the marker and can be resumed.
    records.length = 0;
    const refused = fakeTripo(created(), ok(succeeded(SIGNED_MODEL)), reply(403, { code: 2010 }));
    const credits = await failed(generateModel3d({ provider: refused.provider, request, ...options }));
    assert.deepEqual([...flags(credits), credits.handle.advancing, records.at(-1).advancing], ['credits', true, false, false, undefined, undefined]);
    const resumed = fakeTripo(ok(succeeded(SIGNED_MODEL)), created(CONVERT_TASK), objDone);
    assert.equal((await resumeModel3d({ provider: resumed.provider, handle: records.at(-1), ...options })).handle.taskId, CONVERT_TASK);
    assert.deepEqual(sent(resumed), [`GET /tasks/${TASK}`, 'POST /models/convert', `GET /tasks/${CONVERT_TASK}`]);
});

test('cancel reports that Tripo has no cancel endpoint without sending anything', async () => {
    const { calls, provider } = fakeTripo();
    const result = await provider.cancel(HANDLE);
    assert.deepEqual([result.supported, result.canceled, typeof result.detail], [false, false, 'string']);
    assert.equal(calls.length, 0);
});

test('balance reads available and frozen credits as decimals', async () => {
    const { calls, provider } = fakeTripo(ok({ balance: 10000.25, frozen: 200.5 }), reply(401, { code: 2, message: 'Authentication required' }),
        ok({ frozen: 1 }), dropped('ECONNRESET'));
    assert.deepEqual(await provider.balance(), { balance: 10000.25, unit: 'credits', detail: { frozen: 200.5 } });
    assert.deepEqual(calls[0], { url: `${GLOBAL}/account/balance`, method: 'GET', headers: { Authorization: `Bearer ${KEY}` }, body: undefined });
    assert.equal((await failed(provider.balance())).kind, 'auth');
    assert.equal((await failed(provider.balance())).kind, 'invalidResponse');
    // A failed balance read is not about a task, so it must not say that a task may still be running.
    const lost = await failed(provider.balance());
    assert.deepEqual([lost.kind, /任务/.test(lost.message)], ['network', false]);
    assert.equal(calls.length, 4);

    const cn = fakeProvider({ region: 'cn' }, ok({ balance: 1, frozen: 0 }));
    await cn.provider.balance();
    assert.deepEqual(cn.calls.map(call => call.url), [`${CN}/account/balance`]);
});
