const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { waitForModel3dTask, normalizeModel3dRequest } = require('./model3d-common.cjs');
const { HYPER3D, createHyper3dProvider, buildRodinFields, buildRodinParts, rodinStatus, rodinOutputs } = require('./hyper3d-rodin.cjs');

const KEY = 'rodin-secret-key-123';
const BASE = 'https://api.hyper3d.com/api/v2';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-front-pixels')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-back-pixels')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('webp-left')]);
const ACCEPTED = { message: 'Submitted.', uuid: '123e4567-e89b-12d3-a456-426614174000', consumed: 0.5,
    jobs: { uuids: ['223e4567-e89b-12d3-a456-426614174000'], subscription_key: 'sub-key-1' } };
const HANDLE = { provider: 'hyper3d', taskId: ACCEPTED.uuid, stage: 'generate', format: 'glb', next: null, history: [],
    baseUrl: 'https://api.hyper3d.com/api/v2', subscriptionKey: 'sub-key-1', creditsConsumed: 0.5 };
const SIGNED = 'https://files.hyper3d.test/out/model.glb?X-Amz-Signature=abc';

const reply = (status, body, headers = {}) => ({ status, headers: new Headers(headers),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const jobs = (...statuses) => reply(201, { jobs: statuses.map((status, index) => ({ uuid: `job-${index}`, status })) });

// Records every call and answers from the script: a response, an Error to throw, or a function of the request init.
// A call beyond the script fails the test.
function provider(...script) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        if (!script.length) throw new Error('unexpected request');
        const next = script.shift();
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next(init) : next;
    };
    return { calls, rodin: createHyper3dProvider({ apiKey: KEY, fetchImpl }) };
}

// A scripted request that aborts the caller's signal while it is in flight and then fails like a cancelled fetch.
const abortInFlight = controller => init => {
    controller.abort();
    throw new Error(init.signal.aborted ? 'aborted by fetch' : 'the caller signal was not forwarded');
};

function multipartParts(init) {
    const boundary = /^multipart\/form-data; boundary=(\S+)$/.exec(init.headers['Content-Type'])[1];
    return init.body.toString('latin1').split(`--${boundary}`).slice(1, -1).map(chunk => {
        const split = chunk.indexOf('\r\n\r\n');
        const head = chunk.slice(2, split);
        const data = Buffer.from(chunk.slice(split + 4, -2), 'latin1');
        const filename = /filename="([^"]*)"/.exec(head)?.[1];
        const name = /name="([^"]*)"/.exec(head)[1];
        return filename ? { name, filename, type: /Content-Type: (.+)$/.exec(head)[1], data } : [name, data.toString('utf8')];
    });
}

function imageFiles(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyper3d-rodin-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const write = (name, data) => { const file = path.join(dir, name); fs.writeFileSync(file, data); return file; };
    return { dir, png: write('客户 front.png', PNG), jpeg: write('back.jpg', JPEG), webp: write('left.webp', WEBP), text: write('fake.png', 'not an image') };
}

const flags = error => [error.kind, error.confirmedFailure, error.submissionUnknown, error.retryable];
const normalize = request => normalizeModel3dRequest(request, { ...HYPER3D.limits, formats: HYPER3D.formats }, 'Hyper3D');

test('info describes the documented Rodin surface', () => {
    assert.deepEqual([HYPER3D.id, HYPER3D.name, HYPER3D.baseUrl, HYPER3D.docs], ['hyper3d', 'Hyper3D', BASE, 'docs/api/hyper3d-rodin.md']);
    assert.deepEqual(HYPER3D.modes, ['text', 'image', 'multiview']);
    assert.deepEqual(HYPER3D.formats, ['glb', 'usdz', 'fbx', 'obj', 'stl']);
    assert.equal(HYPER3D.defaultModel, 'Gen-2.5-Medium');
    assert.deepEqual(HYPER3D.models.map(model => model.id), ['Gen-2.5-Extreme-Low', 'Gen-2.5-Low', 'Gen-2.5-Medium', 'Gen-2.5-High',
        'Gen-2.5-Extreme-High', 'Gen-2', 'Sketch', 'Regular', 'Detail', 'Smooth']);
    // /rodin documents no image size or format, so the limits carry neither.
    assert.deepEqual(HYPER3D.limits, { promptMax: 1024, multiview: [2, 4], targetFaces: [500, 2000000], seedMax: 65535 });
    assert.deepEqual([HYPER3D.maxWaitMs, HYPER3D.supportsCancel, HYPER3D.supportsImageUrl], [20 * 60 * 1000, false, false]);
    assert.ok(Object.isFrozen(HYPER3D) && Object.isFrozen(HYPER3D.limits) && Object.isFrozen(HYPER3D.models[0]));
    assert.equal(createHyper3dProvider({ apiKey: KEY, fetchImpl: async () => reply(500, '') }).info, HYPER3D);
});

test('the factory rejects a missing key and a non-HTTPS address, and uses a custom base URL', async () => {
    assert.throws(() => createHyper3dProvider({}), { code: 'MODEL3D_AUTH_FAILED' });
    assert.throws(() => createHyper3dProvider({ apiKey: 'a b' }), { code: 'MODEL3D_AUTH_FAILED' });
    assert.throws(() => createHyper3dProvider({ apiKey: KEY, baseUrl: 'http://api.hyper3d.com/api/v2' }), { code: 'MODEL3D_INVALID_REQUEST' });
    const calls = [];
    const relay = createHyper3dProvider({ apiKey: `  ${KEY}  `, baseUrl: 'https://relay.test/rodin/v2/',
        fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(200, { balance: 1 }); } });
    await relay.balance();
    assert.equal(calls[0].url, 'https://relay.test/rodin/v2/check_balance');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
});

test('unified fields map to Rodin form fields and override providerOptions', () => {
    assert.deepEqual(buildRodinFields(normalize({ mode: 'text', prompt: 'a chair' })),
        { tier: 'Gen-2.5-Medium', prompt: 'a chair', material: 'PBR', geometry_file_format: 'glb' });
    assert.deepEqual(buildRodinFields(normalize({ mode: 'text', prompt: 'a chair', model: 'Gen-2', texture: false, topology: 'quad',
        targetFaces: 18000, format: 'FBX', seed: 0 })),
    { tier: 'Gen-2', prompt: 'a chair', material: 'None', mesh_mode: 'Quad', quality_override: 18000, geometry_file_format: 'fbx', seed: 0 });
    const shaded = buildRodinFields(normalize({ mode: 'text', prompt: 'a chair', pbr: false, topology: 'triangle' }));
    assert.deepEqual([shaded.material, shaded.mesh_mode], ['Shaded', 'Raw']);
    assert.equal('mesh_mode' in buildRodinFields(normalize({ mode: 'image', image: 'a.png' })), false);
    assert.equal('prompt' in buildRodinFields(normalize({ mode: 'image', image: 'a.png' })), false);
    // quality_override is documented as 500 to 2000000 across all tiers.
    assert.deepEqual([500, 2000000].map(targetFaces => buildRodinFields(normalize({ mode: 'text', prompt: 'x', targetFaces })).quality_override),
        [500, 2000000]);

    const merged = buildRodinFields(normalize({ mode: 'text', prompt: 'unified', model: 'Gen-2.5-High', seed: 7, format: 'obj', topology: 'quad',
        targetFaces: 9000, providerOptions: { tier: 'Regular', prompt: 'ignored', material: 'All', mesh_mode: 'Raw', quality_override: 1,
            geometry_file_format: 'stl', seed: 1, quality: 'high', TAPose: true, addons: ['HighPack'] } }));
    // 'All' and 'Hybrid' include the PBR maps, so they survive while PBR is wanted; every other field follows the unified value.
    assert.deepEqual(merged, { tier: 'Gen-2.5-High', prompt: 'unified', material: 'All', mesh_mode: 'Quad', quality_override: 9000,
        geometry_file_format: 'obj', seed: 7, quality: 'high', TAPose: true, addons: ['HighPack'] });
    const material = (providerMaterial, unified) => buildRodinFields(normalize({ mode: 'text', prompt: 'x', ...unified,
        providerOptions: { material: providerMaterial } })).material;
    assert.deepEqual([material('Hybrid', {}), material('Shaded', {}), material('None', {}), material('All', { pbr: false }),
        material('All', { texture: false })], ['Hybrid', 'PBR', 'PBR', 'Shaded', 'None']);
    // Without a unified value the provider option survives; tier still never goes out empty.
    const kept = buildRodinFields(normalize({ mode: 'image', image: 'a.png', providerOptions: { tier: 'Gen-2', prompt: 'hint', mesh_mode: 'Quad' } }));
    assert.deepEqual([kept.tier, kept.prompt, kept.mesh_mode], ['Gen-2', 'hint', 'Quad']);
    assert.throws(() => buildRodinFields(normalize({ mode: 'text', prompt: 'x', providerOptions: { images: 'a.png' } })), { code: 'MODEL3D_INVALID_REQUEST' });
});

test('form parts put images first and reject arrays and other values a form cannot carry', () => {
    const image = { buffer: PNG, mime: 'image/png', ext: 'png', name: 'private name.png' };
    assert.deepEqual(buildRodinParts({ tier: 'Gen-2', seed: 0, TAPose: false, bbox_condition: '[100, 100, 100]', skipped: null, also: undefined }, [image]), [
        { name: 'images', filename: 'image-1.png', contentType: 'image/png', data: PNG },
        { name: 'tier', value: 'Gen-2' }, { name: 'seed', value: 0 }, { name: 'TAPose', value: false },
        { name: 'bbox_condition', value: '[100, 100, 100]' }]);
    // The array encoding is undocumented and the official clients disagree, so the caller has to write the string.
    for (const bad of [{ bbox_condition: { x: 1 } }, { bbox_condition: [100, 100, 100] }, { image_label: ['F', 'B'] }, { addons: ['HighPack'] },
        { hook: () => 1 }]) {
        assert.throws(() => buildRodinParts(bad), { code: 'MODEL3D_INVALID_REQUEST' });
    }
});

test('text submission sends one multipart POST /rodin and returns a storable handle', async () => {
    const { calls, rodin } = provider(reply(201, ACCEPTED));
    const handle = await rodin.submit({ mode: 'text', prompt: ' 一把木椅 a wooden chair ', seed: 42, topology: 'triangle', targetFaces: 20000,
        format: 'usdz', providerOptions: { quality: 'low', addons: 'HighPack', TAPose: true } });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, `${BASE}/rodin`);
    assert.deepEqual([init.method, init.redirect], ['POST', 'error']);
    assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'Content-Type']);
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.match(init.headers['Content-Type'], /^multipart\/form-data; boundary=\S+$/);
    assert.deepEqual(multipartParts(init), [['quality', 'low'], ['addons', 'HighPack'], ['TAPose', 'true'], ['tier', 'Gen-2.5-Medium'],
        ['prompt', '一把木椅 a wooden chair'], ['material', 'PBR'], ['mesh_mode', 'Raw'], ['quality_override', '20000'],
        ['geometry_file_format', 'usdz'], ['seed', '42']]);

    assert.deepEqual(handle, { ...HANDLE, format: 'usdz' });
    assert.deepEqual(JSON.parse(JSON.stringify(handle)), handle);
    assert.equal(JSON.stringify(handle).includes(KEY), false);
    assert.equal((await provider(reply(201, { ...ACCEPTED, consumed: undefined })).rodin.submit({ mode: 'text', prompt: 'x' })).creditsConsumed, null);
    // The official ComfyUI client accepts 200 as well as 201. A created task must not be lost over the status code.
    assert.equal((await provider(reply(200, ACCEPTED)).rodin.submit({ mode: 'text', prompt: 'x' })).taskId, ACCEPTED.uuid);
});

test('image submission uploads the local file bytes and keeps them out of the handle', async t => {
    const files = imageFiles(t);
    const { calls, rodin } = provider(reply(201, ACCEPTED));
    const handle = await rodin.submit({ mode: 'image', images: [files.png], texture: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/rodin`);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.deepEqual(multipartParts(calls[0].init), [{ name: 'images', filename: 'image-1.png', type: 'image/png', data: PNG },
        ['tier', 'Gen-2.5-Medium'], ['material', 'None'], ['geometry_file_format', 'glb']]);
    assert.deepEqual(handle, HANDLE);
    const stored = JSON.stringify(handle);
    for (const secret of [KEY, PNG.toString('base64'), 'data:', 'front', files.dir.replace(/\\/g, '\\\\')]) assert.equal(stored.includes(secret), false, secret);
    // The only address in the record is the API base the task was created on.
    assert.deepEqual(stored.match(/https?:[^"]*/g), [BASE]);

    // The type comes from the bytes, whatever the input form is.
    for (const source of [{ buffer: JPEG, name: 'x.png' }, `data:image/png;base64,${JPEG.toString('base64')}`, { path: files.jpeg }]) {
        const other = provider(reply(201, ACCEPTED));
        await other.rodin.submit({ mode: 'image', image: source });
        assert.deepEqual(multipartParts(other.calls[0].init)[0], { name: 'images', filename: 'image-1.jpg', type: 'image/jpeg', data: JPEG });
    }
});

test('multiview submission repeats the images field front first without view labels', async t => {
    const files = imageFiles(t);
    const { calls, rodin } = provider(reply(201, ACCEPTED));
    await rodin.submit({ mode: 'multiview', prompt: 'robot', model: 'Gen-2.5-High', pbr: false,
        images: [{ source: files.jpeg, view: 'back' }, { source: files.webp, view: 'left' }, { source: files.png, view: 'front' }] });
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].url, calls[0].init.method, calls[0].init.headers.Authorization], [`${BASE}/rodin`, 'POST', `Bearer ${KEY}`]);
    assert.deepEqual(multipartParts(calls[0].init), [
        { name: 'images', filename: 'image-1.png', type: 'image/png', data: PNG },
        { name: 'images', filename: 'image-2.webp', type: 'image/webp', data: WEBP },
        { name: 'images', filename: 'image-3.jpg', type: 'image/jpeg', data: JPEG },
        ['tier', 'Gen-2.5-High'], ['prompt', 'robot'], ['material', 'Shaded'], ['geometry_file_format', 'glb']]);
});

test('requests that cannot be sent are rejected locally without any network call', async t => {
    const files = imageFiles(t);
    const { calls, rodin } = provider();
    for (const bad of [{ mode: 'image', image: 'https://cdn.test/a.png' }, { mode: 'image', image: { url: 'https://cdn.test/a.png' } },
        { mode: 'multiview', images: [files.png, 'https://cdn.test/b.png'] }, { mode: 'image', image: files.text },
        { mode: 'image', image: path.join(files.dir, 'missing.png') }, { mode: 'multiview', images: [files.png] },
        { mode: 'multiview', images: Array(5).fill(files.png) }, { mode: 'text' }, { mode: 'text', prompt: 'x'.repeat(1025) },
        { mode: 'text', prompt: 'x', seed: 65536 }, { mode: 'text', prompt: 'x', targetFaces: 499 },
        { mode: 'text', prompt: 'x', targetFaces: 2000001 }, { mode: 'text', prompt: 'x', format: 'gltf' }, { mode: 'text', prompt: 'x', texture: false, pbr: true },
        { mode: 'text', prompt: 'x', providerOptions: { bbox_condition: { x: 1 } } }]) {
        await assert.rejects(rodin.submit(bad), error => error.code === 'MODEL3D_INVALID_REQUEST' && error.confirmedFailure === true
            && !error.message.includes('cdn.test'), JSON.stringify(bad));
    }
    // The advertised maximum is accepted by the validation it is advertised for.
    assert.equal(normalize({ mode: 'multiview', images: Array(HYPER3D.limits.multiview[1]).fill(files.png) }).images.length, 4);
    const huge = path.join(files.dir, 'huge.png');
    fs.writeFileSync(huge, PNG);
    fs.truncateSync(huge, 50 * 1024 * 1024 + 1);
    await assert.rejects(rodin.submit({ mode: 'image', image: huge }), { code: 'MODEL3D_INVALID_REQUEST', message: /超过 50 MB/ });
    assert.equal(calls.length, 0);
});

test('every documented create failure maps to its kind and is sent exactly once', async () => {
    const rejected = (error, message = 'explained') => reply(201, { error, message });
    const cases = [
        [rejected('API_INSUFFICIENT_FUNDS'), ['credits', true, false, false], 'API_INSUFFICIENT_FUNDS'],
        [rejected('API_PARALLELISM_LIMIT_REACHED'), ['rateLimited', true, false, true], 'API_PARALLELISM_LIMIT_REACHED'],
        [rejected('IMAGE_CONTENT_VIOLATION'), ['content', true, false, false], 'IMAGE_CONTENT_VIOLATION'],
        [rejected('API_NO_ACTIVE_SUBSCRIPTION'), ['forbidden', true, false, false], 'API_NO_ACTIVE_SUBSCRIPTION'],
        [rejected('API_SUBSCRIPTION_PLAN_TOO_LOW'), ['forbidden', true, false, false], 'API_SUBSCRIPTION_PLAN_TOO_LOW'],
        [rejected('PERMISSION_DENIED'), ['forbidden', true, false, false], 'PERMISSION_DENIED'],
        ...['INVALID_REQUEST', 'API_OBJECT_NOT_FOUND_ON_IMAGE', 'IMAGE_LABEL_LENGTH_TOO_LONG', 'NO_SUCH_TASK', 'ASSET_NOT_AVAILABLE',
            'SOME_FUTURE_CODE', 'constructor'].map(code => [rejected(code), ['rejected', true, false, false], code]),
        // "Unexpected server error" is a 5xx in a 201 envelope: it does not say whether the task was created.
        [rejected('API_UNKNOWN'), ['submissionUnknown', false, true, false], 'API_UNKNOWN'],
        // An error next to a task uuid, or an error that is not a code, matches neither documented shape.
        [reply(201, { ...ACCEPTED, error: 'API_INSUFFICIENT_FUNDS' }), ['submissionUnknown', false, true, false], 'API_INSUFFICIENT_FUNDS'],
        [reply(201, { error: 'INVALID_REQUEST', uuid: ACCEPTED.uuid }), ['submissionUnknown', false, true, false], 'INVALID_REQUEST'],
        [reply(201, { error: { code: 'INVALID_REQUEST' } }), ['submissionUnknown', false, true, false], null],
        [reply(201, { error: true, message: 'failed' }), ['submissionUnknown', false, true, false], null],
        [reply(201, { message: 'Submitted.', jobs: ACCEPTED.jobs }), ['invalidResponse', false, true, false], undefined],
        [reply(201, { ...ACCEPTED, uuid: '' }), ['invalidResponse', false, true, false], undefined],
        [reply(201, { ...ACCEPTED, jobs: { uuids: [] } }), ['invalidResponse', false, true, false], undefined],
        [reply(201, { ...ACCEPTED, jobs: undefined }), ['invalidResponse', false, true, false], undefined],
        [reply(201, '<html>ok</html>'), ['invalidResponse', false, true, false], undefined],
        [reply(400, { error: 'INVALID_REQUEST', message: 'bad tier' }), ['rejected', true, false, false], 'INVALID_REQUEST'],
        [reply(400, ''), ['rejected', true, false, false], null],
        [reply(401, ''), ['auth', true, false, false], null],
        [reply(401, { error: `bad token ${KEY}`, message: `Bearer ${KEY} is not valid` }), ['auth', true, false, false], 'bad token ***'],
        [reply(403, ''), ['forbidden', true, false, false], null],
        [reply(404, '<html>not found</html>'), ['rejected', true, false, false], null],
        [reply(429, '', { 'Retry-After': '7' }), ['rateLimited', true, false, true], null],
        [reply(500, { error: 'API_UNKNOWN' }), ['submissionUnknown', false, true, false], 'API_UNKNOWN'],
        [reply(502, '<html>bad gateway</html>'), ['submissionUnknown', false, true, false], null],
        [reply(503, ''), ['submissionUnknown', false, true, false], null],
        // A 2xx other than the documented 201 follows the same body rules: an error code is a rejection, a body without IDs is unknown.
        [reply(200, { error: 'API_INSUFFICIENT_FUNDS' }), ['credits', true, false, false], 'API_INSUFFICIENT_FUNDS'],
        [reply(200, { message: 'ok' }), ['invalidResponse', false, true, false], undefined],
        [reply(204, ''), ['invalidResponse', false, true, false], undefined],
        [Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }), ['submissionUnknown', false, true, false], undefined],
        [new Error('socket hang up'), ['submissionUnknown', false, true, false], undefined],
        // A fetch implementation that quotes the request headers in its error must not leak the key.
        [new Error(`invalid header "Authorization: Bearer ${KEY}"`), ['submissionUnknown', false, true, false], undefined],
        [Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), ['network', true, false, true], undefined]
    ];
    for (const [response, expected, remoteCode] of cases) {
        const { calls, rodin } = provider(response);
        const error = await rodin.submit({ mode: 'text', prompt: 'a chair' }).then(() => null, failure => failure);
        const label = `${response.status || response.message.replace(KEY, '<key>')} ${remoteCode}`;
        assert.ok(error, label);
        assert.deepEqual(flags(error), expected, label);
        assert.equal(error.remoteCode, remoteCode, label);
        assert.equal(calls.length, 1, label);
        assert.equal(`${error.message} ${error.remoteCode}`.includes(KEY), false, label);
    }
    const quoted = await provider(new Error(`invalid header "Authorization: Bearer ${KEY}"`)).rodin.submit({ mode: 'text', prompt: 'x' }).catch(error => error);
    assert.match(quoted.message, /Authorization: Bearer \*\*\*/);
    const limited = await provider(reply(429, '', { 'Retry-After': '7' })).rodin.submit({ mode: 'text', prompt: 'x' }).catch(error => error);
    assert.deepEqual([limited.code, limited.status, limited.retryAfterMs], ['MODEL3D_RATE_LIMITED', 429, 7000]);
    const funds = await provider(rejected('API_INSUFFICIENT_FUNDS', `wallet empty for ${KEY}`)).rodin.submit({ mode: 'text', prompt: 'x' }).catch(error => error);
    assert.equal(funds.code, 'MODEL3D_INSUFFICIENT_CREDITS');
    assert.match(funds.message, /^Hyper3D：账户积分不足（API_INSUFFICIENT_FUNDS wallet empty for \*\*\*）$/);
});

test('a create request that times out is sent once and reported as submissionUnknown', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const calls = [];
    let reached;
    const sent = new Promise(resolve => { reached = resolve; });
    const fetchImpl = (url, init) => new Promise((_resolve, reject) => {
        calls.push({ url, init });
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        reached();
    });
    let settled = false;
    const outcome = createHyper3dProvider({ apiKey: KEY, fetchImpl }).submit({ mode: 'text', prompt: 'a chair' })
        .then(() => null, error => error).finally(() => { settled = true; });
    await sent;
    // The upload gets two minutes: the 30 s default would report an unknown outcome while bytes are still going out.
    t.mock.timers.tick(119000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    t.mock.timers.tick(1000);
    const error = await outcome;
    assert.deepEqual(flags(error), ['submissionUnknown', false, true, false]);
    assert.equal(error.code, 'MODEL3D_SUBMISSION_UNKNOWN');
    assert.equal(calls.length, 1);
});

test('an aborted call surfaces as AbortError, not as a provider failure', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const idle = provider();
    await assert.rejects(idle.rodin.submit({ mode: 'text', prompt: 'x' }, { signal: aborted.signal }), { name: 'AbortError', submissionUnknown: false });
    await assert.rejects(idle.rodin.query(HANDLE, { signal: aborted.signal }), { name: 'AbortError' });
    await assert.rejects(idle.rodin.balance({ signal: aborted.signal }), { name: 'AbortError' });
    assert.equal(idle.calls.length, 0);

    // Aborting while a request is in flight cancels that request and is not retried or reclassified.
    // `creates`: an interrupted create request may already have created a billed task, so that abort carries the warning.
    const inFlight = async (script, call, creates) => {
        const controller = new AbortController();
        const { calls, rodin } = provider(...script, abortInFlight(controller));
        const error = await call(rodin, controller.signal).then(() => null, failure => failure);
        assert.deepEqual([error.name, error.kind, error.submissionUnknown, error.transient], ['AbortError', undefined, creates, undefined]);
        assert.equal(calls.length, script.length + 1);
        assert.equal(calls.at(-1).init.signal.aborted, true);
        return calls.at(-1).url;
    };
    assert.equal(await inFlight([], (rodin, signal) => rodin.submit({ mode: 'text', prompt: 'x' }, { signal }), true), `${BASE}/rodin`);
    assert.equal(await inFlight([], (rodin, signal) => rodin.query(HANDLE, { signal })), `${BASE}/status`);
    assert.equal(await inFlight([jobs('Done')], (rodin, signal) => rodin.query(HANDLE, { signal })), `${BASE}/download`);
    assert.equal(await inFlight([], (rodin, signal) => rodin.balance({ signal })), `${BASE}/check_balance`);
});

test('a stored handle is enough for a new provider instance to finish the task', async () => {
    const first = provider(reply(201, ACCEPTED));
    const stored = JSON.stringify(await first.rodin.submit({ mode: 'text', prompt: 'a chair', format: 'fbx' }));
    const second = provider(jobs('Done'), reply(201, { list: [{ name: 'model.fbx', url: SIGNED.replace('.glb', '.fbx') }] }));
    const status = await second.rodin.query(JSON.parse(stored));
    assert.deepEqual([status.state, status.creditsConsumed, status.outputs.map(output => output.format)], ['succeeded', 0.5, ['fbx']]);
    assert.deepEqual(second.calls.map(call => [call.url, JSON.parse(call.init.body)]),
        [[`${BASE}/status`, { subscription_key: 'sub-key-1' }], [`${BASE}/download`, { task_uuid: ACCEPTED.uuid }]]);
    // Signed result URLs stay in the status and never reach the stored handle: its only address is the API base.
    assert.deepEqual([stored.match(/https?:[^"]*/g), stored.includes('Signature')], [[BASE], false]);
    // A record is only used on the address it was created on, so the key is never sent anywhere else for it.
    const relay = createHyper3dProvider({ apiKey: KEY, baseUrl: 'https://relay.test/rodin/v2', fetchImpl: async () => { throw new Error('must not be called'); } });
    await assert.rejects(relay.query(JSON.parse(stored)), { code: 'MODEL3D_INVALID_REQUEST', confirmedFailure: false });
});

test('job statuses combine into one task state', () => {
    const state = (...statuses) => rodinStatus(statuses.map(status => ({ uuid: 'job', status })));
    assert.deepEqual([state('Waiting'), state('Waiting', 'Waiting')], ['queued', 'queued']);
    assert.deepEqual([state('Generating'), state('Waiting', 'Generating'), state('Done', 'Generating'), state('Done', 'Waiting')],
        ['running', 'running', 'running', 'running']);
    assert.deepEqual([state('Done'), state('Done', 'Done')], ['succeeded', 'succeeded']);
    assert.deepEqual([state('Failed'), state('Done', 'Failed'), state('Failed', 'Generating'), state('Paused', 'Failed')],
        ['failed', 'failed', 'failed', 'failed']);
    assert.deepEqual([rodinStatus([]), rodinStatus(undefined), rodinStatus({}), state('Paused'), state('Done', 'done'), rodinStatus([{}, null])],
        ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
});

test('query posts the subscription key to /status and does not ask for files before the task is done', async () => {
    const expected = { progress: null, outputs: [], error: null, creditsConsumed: 0.5, expiresAt: null, retryAfterMs: null };
    for (const [response, state, remoteStatus] of [[jobs('Waiting', 'Waiting'), 'queued', 'Waiting'], [jobs('Generating'), 'running', 'Generating'],
        [reply(201, { jobs: [{ uuid: 'job-0', status: 'Waiting', queue_length: 3 }] }), 'queued', 'Waiting'],
        [jobs('Done', 'Generating', 'Waiting'), 'running', 'Done,Generating,Waiting'], [jobs('Paused'), 'unknown', 'Paused'],
        [reply(201, { jobs: [] }), 'unknown', null], [reply(201, {}), 'unknown', null], [reply(201, ''), 'unknown', null]]) {
        const { calls, rodin } = provider(response);
        assert.deepEqual(await rodin.query(HANDLE), { state, remoteStatus, ...expected }, remoteStatus);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, `${BASE}/status`);
        assert.deepEqual([calls[0].init.method, calls[0].init.redirect], ['POST', 'error']);
        assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
        assert.deepEqual(JSON.parse(calls[0].init.body), { subscription_key: 'sub-key-1' });
    }
    assert.equal((await provider(jobs('Waiting')).rodin.query({ ...HANDLE, creditsConsumed: undefined })).creditsConsumed, null);
});

test('a failed job ends the task without a download call', async () => {
    const { calls, rodin } = provider(reply(201, { jobs: [{ uuid: 'a', status: 'Done' }, { uuid: 'b', status: 'Failed' }], message: `stopped ${KEY}` }));
    const status = await rodin.query(HANDLE);
    assert.deepEqual([status.state, status.remoteStatus, status.outputs], ['failed', 'Done,Failed', []]);
    assert.deepEqual(status.error, { code: null, retryable: false, message: 'stopped ***' });
    assert.equal(calls.length, 1);
    assert.equal((await provider(jobs('Failed')).rodin.query(HANDLE)).error.message, '服务商没有返回失败原因');
});

test('a finished task fetches the file list with the task uuid and puts the requested format first', async () => {
    const list = [{ name: 'preview.webp', url: 'https://files.hyper3d.test/out/preview.webp?sig=1' },
        { name: 'base.fbx', url: 'https://files.hyper3d.test/out/base.fbx?sig=2' }, { name: 'model.glb', url: SIGNED },
        { name: 'no-url.glb' }, null, { name: 'high.glb', url: 'https://files.hyper3d.test/out/high.glb?sig=3' }];
    const { calls, rodin } = provider(jobs('Done', 'Done'), reply(201, { list }));
    const status = await rodin.query(HANDLE);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, `${BASE}/download`);
    assert.equal(calls[1].init.method, 'POST');
    assert.deepEqual(calls[1].init.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(calls[1].init.body), { task_uuid: ACCEPTED.uuid });
    assert.deepEqual([status.state, status.progress, status.remoteStatus, status.error, status.creditsConsumed], ['succeeded', null, 'Done', null, 0.5]);
    assert.deepEqual(status.outputs, [
        { role: 'model', format: 'glb', url: SIGNED, name: 'model.glb' },
        { role: 'model', format: 'glb', url: 'https://files.hyper3d.test/out/high.glb?sig=3', name: 'high.glb' },
        { role: 'image', format: 'webp', url: 'https://files.hyper3d.test/out/preview.webp?sig=1', name: 'preview.webp' },
        { role: 'model', format: 'fbx', url: 'https://files.hyper3d.test/out/base.fbx?sig=2', name: 'base.fbx' }]);
    assert.deepEqual(rodinOutputs(list, 'fbx').map(output => output.name), ['base.fbx', 'preview.webp', 'model.glb', 'high.glb']);
    assert.deepEqual(rodinOutputs(list, 'obj').map(output => output.name), ['preview.webp', 'base.fbx', 'model.glb', 'high.glb']);
    assert.deepEqual(rodinOutputs(undefined, 'glb'), []);
});

test('query failures keep the task and are transient only when a retry can help', async () => {
    const drop = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const cases = [
        // [scripted responses, kind, transient, confirmedFailure, expected calls]
        [[reply(201, { error: 'NO_SUCH_TASK', message: 'gone' })], 'taskNotFound', undefined, false, 1],
        [[reply(404, '')], 'taskNotFound', undefined, false, 1],
        [[reply(401, '')], 'auth', undefined, false, 1],
        [[reply(400, { error: 'INVALID_REQUEST' })], 'statusUnavailable', false, false, 1],
        [[reply(429, '', { 'Retry-After': '3' })], 'statusUnavailable', true, false, 1],
        [[reply(500, '')], 'statusUnavailable', true, false, 1],
        [[reply(502, '<html>bad gateway</html>')], 'statusUnavailable', true, false, 1],
        [[drop], 'statusUnavailable', true, false, 1],
        [[reply(201, { error: 'API_UNKNOWN' })], 'statusUnavailable', true, false, 1],
        [[jobs('Done'), reply(201, { list: [] })], 'statusUnavailable', true, false, 2],
        [[jobs('Done'), reply(201, {})], 'statusUnavailable', true, false, 2],
        [[jobs('Done'), reply(201, { list: [{ name: 'model.glb' }] })], 'statusUnavailable', true, false, 2],
        [[jobs('Done'), reply(201, { error: 'INVALID_REQUEST', message: 'no files' })], 'statusUnavailable', true, false, 2],
        [[jobs('Done'), reply(201, { error: 'NO_SUCH_TASK' })], 'taskNotFound', undefined, false, 2],
        [[jobs('Done'), reply(503, '')], 'statusUnavailable', true, false, 2],
        [[jobs('Done'), reply(400, '')], 'statusUnavailable', false, false, 2],
        [[jobs('Done'), reply(401, '')], 'auth', undefined, false, 2],
        [[jobs('Done'), drop], 'statusUnavailable', true, false, 2]
    ];
    for (const [script, kind, transient, confirmedFailure, count] of cases) {
        const label = `${kind} after ${count} call(s), HTTP ${script.at(-1).status}`;
        const { calls, rodin } = provider(...script);
        const error = await rodin.query(HANDLE).then(() => null, failure => failure);
        assert.ok(error, label);
        assert.deepEqual([error.kind, error.transient, error.confirmedFailure, error.submissionUnknown], [kind, transient, confirmedFailure, false], label);
        assert.equal(calls.length, count, label);
        assert.equal(error.message.includes(KEY) || error.message.includes('sub-key-1'), false, label);
    }
    const limited = await provider(reply(429, '', { 'Retry-After': '3' })).rodin.query(HANDLE).catch(error => error);
    assert.deepEqual([limited.code, limited.retryAfterMs], ['MODEL3D_STATUS_UNAVAILABLE', 3000]);
    assert.equal((await provider(reply(201, { error: 'NO_SUCH_TASK' })).rodin.query(HANDLE).catch(error => error)).remoteCode, 'NO_SUCH_TASK');
    // Server text and fetch errors are shown with the key masked, on both calls.
    for (const script of [[reply(400, { error: `bad ${KEY}`, message: `token ${KEY}` })], [new Error(`refused Bearer ${KEY}`)],
        [jobs('Done'), reply(400, { error: `bad ${KEY}`, message: `token ${KEY}` })], [jobs('Done'), new Error(`refused Bearer ${KEY}`)]]) {
        const error = await provider(...script).rodin.query(HANDLE).catch(failure => failure);
        assert.equal(error.code, 'MODEL3D_STATUS_UNAVAILABLE');
        assert.match(error.message, /\*\*\*/);
        assert.equal(`${error.message} ${error.remoteCode}`.includes(KEY), false);
    }

    // A broken record is rejected without a request, and without claiming that no task is running.
    const { calls, rodin } = provider();
    for (const bad of [null, {}, { ...HANDLE, provider: 'meshy' }, { ...HANDLE, subscriptionKey: '' }, { ...HANDLE, taskId: undefined }]) {
        await assert.rejects(rodin.query(bad), { code: 'MODEL3D_INVALID_REQUEST', confirmedFailure: false, submissionUnknown: false });
    }
    assert.equal(calls.length, 0);
});

test('polling backs off from 5 s to 30 s and survives a failed status read and a missing file list', async () => {
    const { calls, rodin } = provider(jobs('Waiting'), reply(503, ''), jobs('Generating'), jobs('Done'), reply(201, { list: [] }),
        jobs('Done'), reply(201, { list: [{ name: 'model.glb', url: SIGNED }] }));
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(attempt => rodin.pollDelayMs(attempt)), [5000, 7500, 11250, 16875, 25313, 30000, 30000, 30000]);
    assert.equal(rodin.pollDelayMs(undefined, null), 5000);
    const waits = [];
    const status = await waitForModel3dTask({ provider: 'hyper3d', handle: HANDLE, query: rodin.query, delayMs: rodin.pollDelayMs,
        maxWaitMs: HYPER3D.maxWaitMs, wait: async ms => { waits.push(ms); } });
    assert.equal(status.state, 'succeeded');
    assert.deepEqual(status.outputs.map(output => output.url), [SIGNED]);
    assert.deepEqual(waits, [5000, 7500, 11250, 16875]);
    assert.deepEqual(calls.map(call => call.url.slice(BASE.length)), ['/status', '/status', '/status', '/status', '/download', '/status', '/download']);
});

test('there is one stage, no cancel endpoint, and both answer without a request', async () => {
    const { calls, rodin } = provider();
    assert.equal(rodin.nextStage(HANDLE, { state: 'succeeded', outputs: [] }), null);
    assert.equal(rodin.nextStage(HANDLE, { state: 'running' }), null);
    const error = await rodin.advance(HANDLE, { state: 'succeeded' }, {}).then(() => null, failure => failure);
    assert.deepEqual([error.code, ...flags(error)], ['MODEL3D_UNSUPPORTED', 'unsupported', true, false, false]);
    const canceled = await rodin.cancel(HANDLE);
    assert.deepEqual([canceled.supported, canceled.canceled, typeof canceled.detail], [false, false, 'string']);
    assert.equal(calls.length, 0);
});

test('balance reads GET /check_balance and classifies failures without task wording', async () => {
    const { calls, rodin } = provider(reply(200, { balance: 10.5 }));
    assert.deepEqual(await rodin.balance(), { balance: 10.5, unit: 'credits', detail: {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/check_balance`);
    assert.deepEqual([calls[0].init.method, calls[0].init.body, calls[0].init.redirect], ['GET', undefined, 'error']);
    assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${KEY}` });
    assert.equal((await provider(reply(200, { balance: 0 })).rodin.balance()).balance, 0);

    for (const [response, kind, retryable] of [[reply(401, ''), 'auth', false], [reply(429, '', { 'Retry-After': '2' }), 'rateLimited', true],
        [reply(200, { error: 'API_NO_ACTIVE_SUBSCRIPTION', message: 'Full API access required' }), 'forbidden', false],
        [reply(200, { error: 'PERMISSION_DENIED' }), 'forbidden', false], [reply(200, { error: 'API_UNKNOWN', balance: 3 }), 'invalidResponse', false],
        [reply(200, {}), 'invalidResponse', false], [reply(200, { balance: '10' }), 'invalidResponse', false], [reply(503, ''), 'unavailable', true], [reply(400, ''), 'rejected', false],
        [reply(403, { error: `denied ${KEY}`, message: `Bearer ${KEY}` }), 'forbidden', false],
        [Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'network', true],
        [new Error(`refused Bearer ${KEY}`), 'network', true]]) {
        const failing = provider(response);
        const error = await failing.rodin.balance().then(() => null, failure => failure);
        assert.deepEqual([error.kind, error.retryable, error.submissionUnknown], [kind, retryable, false], `${response.status} ${kind}`);
        assert.equal(failing.calls.length, 1);
        assert.equal(`${error.message} ${error.remoteCode}`.includes(KEY), false);
    }
});
