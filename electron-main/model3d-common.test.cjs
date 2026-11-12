const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { model3dError, assertApiKey, resolveBaseUrl, retryAfterMs, requestNeverSent, httpRequest, submitFailure, queryFailure, readFailure,
    sniffImage, loadModel3dImage, toDataUri, encodeMultipart, model3dOutput, normalizeModel3dRequest, waitForModel3dTask,
    downloadModel3dOutput } = require('./model3d-common.cjs');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
const response = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300,
    headers: new Headers(headers), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('error kinds separate "no task exists" from "a task may exist and be billed"', () => {
    const rejected = model3dError('rejected', 'Meshy', { detail: 'bad' });
    assert.deepEqual([rejected.code, rejected.confirmedFailure, rejected.submissionUnknown, rejected.retryable],
        ['MODEL3D_REQUEST_REJECTED', true, false, false]);
    const unknown = model3dError('submissionUnknown', 'Meshy');
    assert.deepEqual([unknown.confirmedFailure, unknown.submissionUnknown, unknown.retryable], [false, true, false]);
    assert.equal(model3dError('rateLimited', 'Tripo').retryable, true);
    assert.equal(model3dError('waitTimeout', 'Tripo').confirmedFailure, false);
    assert.match(rejected.message, /^Meshy：请求被拒绝（bad）$/);
    assert.ok(model3dError('rejected', 'X', { detail: 'a'.repeat(1000) }).message.length < 340);
});

test('API keys and base URLs reject values that could break the header or leak the key', () => {
    assert.equal(assertApiKey('  msy_abc  ', 'Meshy'), 'msy_abc');
    // A pasted zero-width space or full-width character would make fetch throw before sending anything.
    for (const bad of ['', '   ', 'a b', 'a\r\nX-Injected: 1', null, 'msy_abc\u200b', 'msy_密钥', 'msy_\u00e9']) {
        assert.throws(() => assertApiKey(bad, 'Meshy'), { code: 'MODEL3D_AUTH_FAILED' });
    }
    assert.equal(resolveBaseUrl('', 'https://api.meshy.ai/openapi/', 'Meshy'), 'https://api.meshy.ai/openapi');
    assert.equal(resolveBaseUrl('https://relay.test/v3', 'https://x.test', 'Tripo'), 'https://relay.test/v3');
    for (const bad of ['http://api.meshy.ai', 'https://user:pw@api.meshy.ai', 'https://api.meshy.ai/?a=1', 'not a url']) {
        assert.throws(() => resolveBaseUrl(bad, 'https://x.test', 'Meshy'), { code: 'MODEL3D_INVALID_REQUEST' });
    }
});

test('Retry-After accepts seconds and HTTP dates and is capped', () => {
    assert.equal(retryAfterMs(new Headers({ 'Retry-After': '7' })), 7000);
    assert.equal(retryAfterMs({ 'retry-after': '2' }), 2000);
    assert.equal(retryAfterMs(new Headers({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:10 GMT' }), Date.parse('2026-10-21T07:28:00Z')), 10000);
    assert.equal(retryAfterMs(new Headers({ 'Retry-After': '99999' })), 300000);
    assert.equal(retryAfterMs(new Headers()), null);
    assert.equal(retryAfterMs(new Headers({ 'Retry-After': 'soon' })), null);
});

test('only connection-level failures count as never sent', () => {
    assert.equal(requestNeverSent(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true);
    assert.equal(requestNeverSent(new Error('net::ERR_NAME_NOT_RESOLVED')), true);
    // A connection that was never established cannot have carried the request.
    assert.equal(requestNeverSent(Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), true);
    assert.equal(requestNeverSent(Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH', syscall: 'connect' } })), true);
    // Anything a socket can also report after the request went out is not proof.
    for (const message of ['net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_RESET', 'net::ERR_ADDRESS_UNREACHABLE',
        'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_NETWORK_CHANGED']) assert.equal(requestNeverSent(new Error(message)), false, message);
    for (const cause of [{ code: 'ENETUNREACH' }, { code: 'EHOSTUNREACH', syscall: 'write' }, { code: 'ETIMEDOUT', syscall: 'connect' }, { code: 'EPIPE' }]) {
        assert.equal(requestNeverSent(Object.assign(new Error('fetch failed'), { cause })), false, JSON.stringify(cause));
    }
    assert.equal(requestNeverSent(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })), false);
    assert.equal(requestNeverSent(new Error('socket hang up')), false);
});

test('httpRequest returns every HTTP status, forbids redirects and classifies transport failures', async () => {
    const calls = [];
    const ok = await httpRequest(async (url, init) => { calls.push({ url, init }); return response(429, { message: 'slow' }, { 'Retry-After': '3' }); },
        { method: 'POST', url: 'https://api.test/x', headers: { Authorization: 'Bearer k' }, body: '{}' });
    assert.equal(ok.status, 429);
    assert.deepEqual(ok.json, { message: 'slow' });
    assert.equal(calls[0].init.redirect, 'error');
    const html = await httpRequest(async () => response(502, '<html>bad gateway</html>'), { url: 'https://api.test/x' });
    assert.equal(html.json, null);

    await assert.rejects(httpRequest(async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); },
        { url: 'https://api.test/x' }), { transport: true, neverSent: true, timedOut: false });
    await assert.rejects(httpRequest((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }), { url: 'https://api.test/x', timeoutMs: 10 }), { transport: true, timedOut: true, neverSent: false });

    const controller = new AbortController();
    const pending = httpRequest((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }), { url: 'https://api.test/x', signal: controller.signal });
    controller.abort();
    // An abort says whether the request had already been handed to fetch.
    await assert.rejects(pending, { name: 'AbortError', dispatched: true });
    let sent = 0;
    await assert.rejects(httpRequest(async () => { sent += 1; return response(200, {}); }, { url: 'https://api.test/x', signal: controller.signal }),
        { name: 'AbortError', dispatched: false });
    assert.equal(sent, 0);
    // A missing fetch implementation is a setup error, never an exchange with an unknown outcome.
    const original = globalThis.fetch;
    globalThis.fetch = undefined;
    try {
        await assert.rejects(httpRequest(undefined, { url: 'https://api.test/x' }), error => error.transport === undefined && /缺少网络请求实现/.test(error.message));
    } finally { globalThis.fetch = original; }
});

test('submit failures never mark an uncertain outcome as safe to resubmit', () => {
    const byStatus = status => submitFailure('Meshy', { response: response(status, {}) });
    assert.deepEqual([400, 401, 402, 403, 404, 422, 429].map(status => byStatus(status).kind),
        ['rejected', 'auth', 'credits', 'forbidden', 'rejected', 'rejected', 'rateLimited']);
    for (const status of [400, 401, 402, 403, 404, 422, 429]) assert.equal(byStatus(status).confirmedFailure, true);
    for (const status of [408, 425, 500, 502, 503, 504, 200, 302]) {
        assert.equal(byStatus(status).submissionUnknown, true);
        assert.equal(byStatus(status).confirmedFailure, false);
        assert.equal(byStatus(status).retryable, false);
    }
    assert.equal(submitFailure('Meshy', { response: response(429, {}, { 'Retry-After': '4' }) }).retryAfterMs, 4000);
    assert.equal(submitFailure('Meshy', { transport: { transport: true, timedOut: true, neverSent: false, message: 't' } }).submissionUnknown, true);
    assert.equal(submitFailure('Meshy', { transport: { transport: true, neverSent: false, message: 'reset' } }).submissionUnknown, true);
    const never = submitFailure('Meshy', { transport: { transport: true, neverSent: true, message: 'refused' } });
    assert.deepEqual([never.kind, never.confirmedFailure, never.retryable], ['network', true, true]);
    assert.equal(submitFailure('Tripo', { response: response(403, {}), kind: 'credits' }).code, 'MODEL3D_INSUFFICIENT_CREDITS');
    // An abort stays an abort, but only one known to precede the request is free of the "task may exist" warning.
    const abort = fields => Object.assign(new Error('中断'), { name: 'AbortError' }, fields);
    assert.deepEqual([{ dispatched: true }, {}, { dispatched: false }].map(fields => {
        const error = submitFailure('Meshy', { transport: abort(fields) });
        return [error.name, error.submissionUnknown];
    }), [['AbortError', true], ['AbortError', true], ['AbortError', false]]);
});

test('query failures keep the task: only network, 429 and 5xx are transient', () => {
    const byStatus = status => queryFailure('Tripo', { response: response(status, {}) });
    assert.equal(byStatus(401).kind, 'auth');
    assert.equal(byStatus(404).kind, 'taskNotFound');
    for (const status of [408, 425, 429, 500, 503]) assert.equal(byStatus(status).transient, true);
    assert.equal(byStatus(400).transient, false);
    assert.equal(queryFailure('Tripo', { transport: { transport: true, message: 'reset' } }).transient, true);
    for (const status of [401, 404, 429, 500]) assert.equal(byStatus(status).confirmedFailure, false);
});

test('a failed read that is not about a task is always safe to repeat and never mentions a task', () => {
    const byStatus = status => readFailure('Meshy', { response: response(status, {}, { 'Retry-After': '2' }) });
    assert.deepEqual([401, 403, 429, 400, 500, 503].map(status => byStatus(status).kind),
        ['auth', 'forbidden', 'rateLimited', 'rejected', 'unavailable', 'unavailable']);
    assert.deepEqual([byStatus(503).code, byStatus(503).retryable, byStatus(429).retryAfterMs], ['MODEL3D_SERVICE_UNAVAILABLE', true, 2000]);
    const dropped = readFailure('Meshy', { transport: { transport: true, message: 'reset' } });
    assert.deepEqual([dropped.kind, dropped.retryable], ['network', true]);
    for (const error of [byStatus(401), byStatus(500), dropped]) assert.doesNotMatch(error.message, /任务/);
    const abort = Object.assign(new Error('中断'), { name: 'AbortError' });
    assert.equal(readFailure('Meshy', { transport: abort }), abort);
});

test('images are identified by content, limited by size and never trusted by extension', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model3d-image-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal(sniffImage(PNG).ext, 'png');
    assert.equal(sniffImage(JPEG).mime, 'image/jpeg');
    assert.equal(sniffImage(WEBP).ext, 'webp');
    assert.equal(sniffImage(Buffer.from('GIF89a')), null);

    const mislabeled = path.join(dir, 'photo.png');
    fs.writeFileSync(mislabeled, JPEG);
    const image = await loadModel3dImage(mislabeled, { provider: 'Meshy' });
    assert.deepEqual([image.mime, image.ext, image.name], ['image/jpeg', 'jpg', 'photo.jpg']);
    assert.match(toDataUri(image), /^data:image\/jpeg;base64,\/9j\//);
    assert.equal((await loadModel3dImage({ buffer: WEBP, name: 'a.bin' })).name, 'a.webp');
    assert.equal((await loadModel3dImage(`data:image/png;base64,${PNG.toString('base64')}`)).mime, 'image/png');
    assert.deepEqual(await loadModel3dImage('https://cdn.test/a.png'), { url: 'https://cdn.test/a.png' });

    const script = path.join(dir, 'fake.png');
    fs.writeFileSync(script, 'MZ not an image');
    for (const bad of [script, path.join(dir, 'missing.png'), dir, { buffer: Buffer.alloc(0) }, {}, 'data:text/plain,hello',
        { url: 'ftp://x.test/a.png' }, { url: 'https://user:pw@x.test/a.png' }]) {
        await assert.rejects(loadModel3dImage(bad, { provider: 'Meshy' }), { code: 'MODEL3D_INVALID_REQUEST' });
    }
    await assert.rejects(loadModel3dImage(mislabeled, { maxBytes: 4 }), /超过/);
    await assert.rejects(loadModel3dImage({ buffer: WEBP }, { formats: ['image/jpeg', 'image/png'] }), /格式不受支持/);
    await assert.rejects(loadModel3dImage('https://cdn.test/a.png', { allowUrl: false }), /本地文件/);
});

test('multipart encoding carries text fields, repeated files and escaped names', () => {
    const { body, contentType } = encodeMultipart([{ name: 'tier', value: 'Gen-2' },
        { name: 'images', filename: 'a "b".png', contentType: 'image/png', data: PNG },
        { name: 'images', filename: 'c\r\nd.jpg', contentType: 'image/jpeg', data: JPEG }]);
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(contentType)[1];
    const text = body.toString('latin1');
    assert.equal(text.split(`--${boundary}`).length, 5);
    assert.ok(text.endsWith(`--${boundary}--\r\n`));
    assert.ok(text.includes('Content-Disposition: form-data; name="tier"\r\n\r\nGen-2\r\n'));
    assert.ok(text.includes('name="images"; filename="a %22b%22.png"\r\nContent-Type: image/png\r\n\r\n'));
    assert.ok(text.includes('filename="c  d.jpg"'));
    assert.ok(body.includes(PNG) && body.includes(JPEG));
});

test('outputs infer role and format from the name or URL', () => {
    assert.deepEqual(model3dOutput({ url: 'https://cdn.test/a/model.GLB?Expires=1' }),
        { role: 'model', format: 'glb', url: 'https://cdn.test/a/model.GLB?Expires=1', name: null });
    assert.equal(model3dOutput({ url: 'https://cdn.test/x', name: 'preview.png' }).role, 'image');
    assert.equal(model3dOutput({ url: 'https://cdn.test/converted-model', format: 'fbx' }).format, 'fbx');
    assert.deepEqual([model3dOutput({ url: 'https://cdn.test/converted-model' }).format, model3dOutput({ url: 'https://cdn.test/x' }).role], [null, 'file']);
    assert.equal(model3dOutput({ url: 'https://cdn.test/t.png', role: 'thumbnail' }).role, 'thumbnail');
    assert.equal(model3dOutput({}), null);
});

test('request normalization fills defaults and orders multiview images front first', () => {
    const limits = { promptMax: 20, multiview: [2, 4], formats: ['glb', 'fbx'], targetFaces: [100, 300000], seedMax: 65535 };
    assert.deepEqual(normalizeModel3dRequest({ mode: 'text', prompt: ' a chair ' }, limits),
        { mode: 'text', prompt: 'a chair', images: [], texture: true, pbr: true, topology: null, targetFaces: null, format: 'glb',
            seed: null, model: null, providerOptions: {}, stageOptions: {} });
    const untextured = normalizeModel3dRequest({ mode: 'image', image: 'a.png', texture: false, format: 'FBX', topology: 'quad',
        targetFaces: 5000, seed: 7, model: 'meshy-7.1' }, limits);
    assert.deepEqual([untextured.texture, untextured.pbr, untextured.format, untextured.topology, untextured.targetFaces, untextured.seed,
        untextured.model, untextured.images], [false, false, 'fbx', 'quad', 5000, 7, 'meshy-7.1', [{ source: 'a.png', view: undefined }]]);
    assert.equal(normalizeModel3dRequest({ mode: 'image', image: 'a.png', pbr: false }, limits).texture, true);

    const views = normalizeModel3dRequest({ mode: 'multiview', images: [{ source: 'b.png', view: 'back' }, 'f.png', { path: 'r.png', view: 'right' }] }, limits);
    assert.deepEqual(views.images.map(image => image.view), ['front', 'back', 'right']);
    assert.deepEqual(views.images[0].source, 'f.png');
    assert.deepEqual(views.images[2].source, { path: 'r.png', view: 'right' });
    assert.deepEqual(normalizeModel3dRequest({ mode: 'multiview', images: ['1', '2', '3', '4'] }, limits).images.map(image => image.view),
        ['front', 'left', 'back', 'right']);

    for (const bad of [{ mode: 'video' }, { mode: 'text' }, { mode: 'text', prompt: 'x'.repeat(21) }, { mode: 'text', prompt: 'x', images: ['a'] },
        { mode: 'image' }, { mode: 'image', images: ['a', 'b'] }, { mode: 'multiview', images: ['a'] }, { mode: 'multiview', images: ['a', 'b', 'c', 'd', 'e'] },
        { mode: 'multiview', images: [{ source: 'a', view: 'left' }, { source: 'b', view: 'left' }] },
        { mode: 'multiview', images: [{ source: 'a', view: 'top' }, 'b'] },
        { mode: 'multiview', images: [{ source: 'a', view: 'left' }, { source: 'b', view: 'back' }, { source: 'c', view: 'right' }] },
        { mode: 'text', prompt: 'x', texture: false, pbr: true }, { mode: 'text', prompt: 'x', topology: 'ngon' },
        { mode: 'text', prompt: 'x', targetFaces: 50 }, { mode: 'text', prompt: 'x', targetFaces: 1.5 }, { mode: 'text', prompt: 'x', format: 'blend' },
        { mode: 'text', prompt: 'x', seed: -1 }, { mode: 'text', prompt: 'x', seed: 65536 }, { mode: 'text', prompt: 'x', model: 'a b' },
        { mode: 'text', prompt: 'x', providerOptions: [] }]) {
        assert.throws(() => normalizeModel3dRequest(bad, limits, 'Meshy'), { code: 'MODEL3D_INVALID_REQUEST' }, JSON.stringify(bad));
    }
});

test('polling survives transient query failures, honors Retry-After and stops on real errors or the deadline', async () => {
    const handle = { provider: 'tripo', taskId: 't1' };
    const waits = [];
    const wait = async ms => { waits.push(ms); };
    const transient = Object.assign(new Error('503'), { transient: true, retryAfterMs: 9000 });
    const script = [{ state: 'queued', progress: 0 }, transient, { state: 'running', progress: 40, retryAfterMs: 1234 }, { state: 'succeeded', progress: 100 }];
    const progress = [];
    const done = await waitForModel3dTask({ provider: 'tripo', handle, wait, delayMs: attempt => 2000 + attempt,
        onProgress: event => progress.push(event.recovering ? 'recovering' : event.status.state),
        query: async () => { const next = script.shift(); if (next instanceof Error) throw next; return next; } });
    assert.equal(done.state, 'succeeded');
    assert.deepEqual(waits, [2000, 9000, 1234]);
    assert.deepEqual(progress, ['queued', 'recovering', 'running', 'succeeded']);

    let calls = 0;
    await assert.rejects(waitForModel3dTask({ provider: 'tripo', handle, wait, delayMs: () => 1, maxQueryFailures: 2,
        query: async () => { calls += 1; throw Object.assign(new Error('down'), { transient: true }); } }), error => error.handle === handle);
    assert.equal(calls, 3);

    calls = 0;
    await assert.rejects(waitForModel3dTask({ provider: 'tripo', handle, wait, delayMs: () => 1,
        query: async () => { calls += 1; throw Object.assign(new Error('gone'), { code: 'MODEL3D_TASK_NOT_FOUND' }); } }), { code: 'MODEL3D_TASK_NOT_FOUND' });
    assert.equal(calls, 1);

    let clock = 0;
    await assert.rejects(waitForModel3dTask({ provider: 'tripo', handle, delayMs: () => 1000, maxWaitMs: 2500, now: () => clock,
        wait: async ms => { clock += ms; }, query: async () => ({ state: 'running', progress: 10 }) }),
    error => error.code === 'MODEL3D_WAIT_TIMEOUT' && error.confirmedFailure === false && error.handle === handle && error.lastStatus.progress === 10);

    for (const state of ['failed', 'canceled']) {
        assert.equal((await waitForModel3dTask({ handle, wait, delayMs: () => 1, query: async () => ({ state }) })).state, state);
    }

    // The gap between queries never drops below one second, even for "Retry-After: 0" or a zero provider delay,
    // and a task that was just created is not queried before the initial delay has passed.
    const order = [];
    const replies = [{ state: 'running', retryAfterMs: 0 }, Object.assign(new Error('429'), { transient: true, retryAfterMs: 0 }),
        { state: 'running' }, { state: 'succeeded' }];
    await waitForModel3dTask({ handle, delayMs: () => 0, initialDelayMs: 5000, wait: async ms => { order.push(ms); },
        query: async () => { order.push('query'); const next = replies.shift(); if (next instanceof Error) throw next; return next; } });
    assert.deepEqual(order, [5000, 'query', 1000, 'query', 1000, 'query', 1000, 'query']);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(waitForModel3dTask({ handle, signal: controller.signal, delayMs: () => 1, query: async () => ({ state: 'running' }) }), { name: 'AbortError' });
});

test('downloads write atomically without credentials, avoid overwriting and reject unsafe URLs', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model3d-download-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const data = Buffer.from('glTF-binary-model');
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(data); };
    const output = { role: 'model', format: 'glb', url: 'https://assets.test/task/model.glb?Signature=abc', name: null };
    const first = await downloadModel3dOutput(output, { dir, baseName: 'chair', fetchImpl });
    assert.deepEqual([path.basename(first.path), first.bytes, first.format, first.role], ['chair.glb', data.length, 'glb', 'model']);
    assert.deepEqual(fs.readFileSync(first.path), data);
    assert.equal(calls[0].init.headers, undefined);
    assert.equal(path.basename((await downloadModel3dOutput(output, { dir, baseName: 'chair', fetchImpl })).path), 'chair-2.glb');
    assert.equal(path.basename((await downloadModel3dOutput({ url: 'https://assets.test/converted-model', format: 'FBX' },
        { dir, baseName: '../..\\evil:name', fetchImpl })).path), '.._.._evil_name.fbx');

    await assert.rejects(downloadModel3dOutput(output, { dir, baseName: 'big', fetchImpl, maxBytes: 4 }), { code: 'MODEL3D_DOWNLOAD_FAILED' });
    await assert.rejects(downloadModel3dOutput(output, { dir, baseName: 'gone', fetchImpl: async () => new Response('no', { status: 403 }) }), /HTTP 403/);
    await assert.rejects(downloadModel3dOutput(output, { dir, baseName: 'empty', fetchImpl: async () => new Response(Buffer.alloc(0)) }), /为空/);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.._.._evil_name.fbx', 'chair-2.glb', 'chair.glb']);

    const before = calls.length;
    for (const url of ['http://assets.test/model.glb', 'https://127.0.0.1/model.glb', 'https://localhost/model.glb', 'https://10.0.0.5/m.glb',
        'https://[::1]/m.glb', 'https://user:pw@assets.test/m.glb', 'https://printer.local/m.glb', 'file:///C:/x.glb', '']) {
        await assert.rejects(downloadModel3dOutput({ url, format: 'glb' }, { dir, fetchImpl }), { code: 'MODEL3D_DOWNLOAD_FAILED' }, url);
    }
    assert.equal(calls.length, before);
    await assert.rejects(downloadModel3dOutput(output, { fetchImpl }), /保存目录/);
});
