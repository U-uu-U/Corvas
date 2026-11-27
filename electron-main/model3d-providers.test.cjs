const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { model3dError } = require('./model3d-common.cjs');
const { MODEL3D_PROVIDERS, listModel3dProviders, createModel3dProvider, generateModel3d, resumeModel3d, queryModel3d,
    cancelModel3d, getModel3dBalance, primaryOutput } = require('./model3d-providers.cjs');

const wait = async () => {};
const glb = { role: 'model', format: 'glb', url: 'https://cdn.test/model.glb?sig=1', name: null };
const fbx = { role: 'model', format: 'fbx', url: 'https://cdn.test/model.fbx?sig=1', name: null };
const thumb = { role: 'thumbnail', format: 'png', url: 'https://cdn.test/preview.png?sig=1', name: 'preview' };
const status = (state, outputs = [], extras = {}) => ({ state, progress: state === 'succeeded' ? 100 : 10, remoteStatus: state,
    outputs, error: null, creditsConsumed: null, expiresAt: null, retryAfterMs: null, ...extras });

// Two-stage provider: 'generate' then a billable 'convert', like Tripo with a non-GLB format.
function fakeProvider({ queries = {}, advance, stages = true } = {}) {
    const log = [];
    return { log, info: { id: 'fake', name: 'Fake', maxWaitMs: 60000 }, pollDelayMs: attempt => (attempt === 0 ? 5000 : 2000),
        async submit(request) { log.push('submit'); return { provider: 'fake', taskId: 'gen-1', stage: 'generate', format: request.format, next: stages ? { stage: 'convert', body: {} } : null, history: [] }; },
        async query(handle) {
            log.push(`query:${handle.taskId}`);
            const next = queries[handle.taskId]?.shift();
            if (next instanceof Error) throw next;
            return next || status('succeeded', handle.stage === 'convert' ? [fbx, thumb] : [glb, thumb]);
        },
        nextStage(handle) { return handle.next ? { stage: handle.next.stage } : null; },
        async advance(handle) {
            log.push('advance');
            if (advance) return advance(handle);
            return { provider: 'fake', taskId: 'conv-1', stage: 'convert', format: handle.format, next: null, history: [{ stage: 'generate', taskId: handle.taskId }] };
        },
        async cancel() { return { supported: false, canceled: false, detail: '' }; },
        async balance() { return { balance: 42, unit: 'credits', detail: {} }; } };
}

test('the registry exposes the three providers with the fields the contract requires', () => {
    assert.deepEqual(Object.keys(MODEL3D_PROVIDERS).sort(), ['hyper3d', 'meshy', 'tripo']);
    for (const info of listModel3dProviders()) {
        assert.equal(MODEL3D_PROVIDERS[info.id], info);
        for (const field of ['name', 'docs', 'baseUrl', 'defaultModel']) assert.equal(typeof info[field], 'string', `${info.id}.${field}`);
        assert.ok(fs.existsSync(path.join(__dirname, '..', info.docs)), `${info.id} docs file exists`);
        assert.deepEqual(info.modes, ['text', 'image', 'multiview']);
        assert.ok(info.formats.includes('glb') && info.models.some(model => model.id === info.defaultModel));
        assert.ok(info.maxWaitMs >= 10 * 60 * 1000 && info.limits.promptMax > 0 && info.limits.multiview.length === 2);
        assert.equal(typeof info.supportsCancel, 'boolean');
        assert.equal(typeof info.supportsImageUrl, 'boolean');
        const provider = createModel3dProvider(info.id, { apiKey: 'test-key', fetchImpl: async () => { throw new Error('no network in tests'); } });
        assert.equal(provider.info, info);
        for (const method of ['submit', 'query', 'nextStage', 'advance', 'cancel', 'balance', 'pollDelayMs']) assert.equal(typeof provider[method], 'function');
        assert.throws(() => createModel3dProvider(info.id, { apiKey: '' }), { code: 'MODEL3D_AUTH_FAILED' });
    }
    assert.throws(() => createModel3dProvider('unknown', {}), { code: 'MODEL3D_INVALID_REQUEST' });
});

test('generate saves every handle change, marks the second submission before sending it and downloads the final model', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model3d-run-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const provider = fakeProvider({ queries: { 'gen-1': [status('queued'), status('running')] } });
    const handles = [];
    const fetched = [];
    const result = await generateModel3d({ provider, request: { format: 'fbx' }, wait, saveDir: dir, baseName: 'chair',
        onHandle: handle => handles.push(JSON.parse(JSON.stringify(handle))),
        fetchImpl: async url => { fetched.push(url); return new Response('model-bytes'); } });
    assert.deepEqual(provider.log, ['submit', 'query:gen-1', 'query:gen-1', 'query:gen-1', 'advance', 'query:conv-1']);
    assert.deepEqual(handles.map(handle => [handle.taskId, handle.stage, handle.advancing || null]),
        [['gen-1', 'generate', null], ['gen-1', 'generate', 'convert'], ['conv-1', 'convert', null]]);
    assert.deepEqual([result.provider, result.handle.taskId, result.primary], ['fake', 'conv-1', fbx]);
    assert.deepEqual(fetched, [fbx.url]);
    assert.deepEqual(result.files.map(file => [path.basename(file.path), file.role]), [['chair.fbx', 'model']]);
    assert.equal(primaryOutput(status('succeeded', [thumb, glb, fbx]), { format: 'fbx' }), fbx);
    assert.equal(primaryOutput(status('succeeded', [thumb, glb]), { format: 'fbx' }), glb);
    assert.equal(primaryOutput(status('succeeded', [thumb]), { format: 'glb' }), null);
});

test('a task that was just created is not queried at once, while a resumed one is', async () => {
    const trace = provider => { const steps = []; const record = async ms => { steps.push(ms); };
        const original = provider.query; provider.query = async (...args) => { steps.push('query'); return original(...args); };
        return { steps, record }; };
    const created = fakeProvider();
    const first = trace(created);
    const result = await generateModel3d({ provider: created, request: { format: 'fbx' }, wait: first.record });
    // Both the generation and the convert task are new, so each gets the provider's first delay before its first query.
    assert.deepEqual(first.steps, [5000, 'query', 5000, 'query']);

    const saved = { provider: 'fake', taskId: 'gen-1', stage: 'generate', format: 'fbx', next: { stage: 'convert', body: {} }, history: [] };
    const resumed = fakeProvider();
    const second = trace(resumed);
    await resumeModel3d({ provider: resumed, handle: saved, wait: second.record });
    assert.deepEqual(second.steps, ['query', 5000, 'query']);
    assert.equal(result.handle.taskId, 'conv-1');
});

test('an uncertain second submission is never repeated on resume unless the caller says so', async () => {
    const unknown = () => { throw model3dError('submissionUnknown', 'Fake'); };
    const provider = fakeProvider({ advance: unknown });
    const handles = [];
    const failure = await generateModel3d({ provider, request: { format: 'fbx' }, wait, onHandle: handle => handles.push(handle) }).catch(error => error);
    assert.equal(failure.code, 'MODEL3D_SUBMISSION_UNKNOWN');
    assert.deepEqual([failure.handle.taskId, failure.handle.advancing, failure.stage], ['gen-1', 'convert', 'convert']);
    assert.equal(handles.at(-1).advancing, 'convert');

    const again = fakeProvider();
    const blocked = await resumeModel3d({ provider: again, handle: failure.handle, wait }).catch(error => error);
    assert.deepEqual([blocked.code, blocked.submissionUnknown, blocked.handle.advancing], ['MODEL3D_SUBMISSION_UNKNOWN', true, 'convert']);
    assert.deepEqual(again.log, []);

    const forced = await resumeModel3d({ provider: again, handle: failure.handle, wait, resubmitUnknownStage: true });
    assert.deepEqual(again.log, ['query:gen-1', 'advance', 'query:conv-1']);
    assert.equal(forced.handle.taskId, 'conv-1');
});

test('a rejected second submission clears the marker so resume may try again, and an abort only does so before sending', async () => {
    const rejected = fakeProvider({ advance: () => { throw model3dError('rateLimited', 'Fake'); } });
    const handles = [];
    const failure = await generateModel3d({ provider: rejected, request: { format: 'fbx' }, wait, onHandle: handle => handles.push(handle) }).catch(error => error);
    assert.equal(failure.code, 'MODEL3D_RATE_LIMITED');
    assert.equal(failure.handle.advancing, undefined);
    assert.deepEqual(handles.map(handle => handle.advancing || null), [null, 'convert', null]);
    const resumed = await resumeModel3d({ provider: fakeProvider(), handle: failure.handle, wait });
    assert.equal(resumed.handle.taskId, 'conv-1');

    // An abort keeps the marker unless it is known to have come before the request went out.
    const abortWith = fields => fakeProvider({ advance: () => { throw Object.assign(new Error('中断'), { name: 'AbortError' }, fields); } });
    for (const [fields, marker] of [[{}, 'convert'], [{ dispatched: true, submissionUnknown: true }, 'convert'], [{ dispatched: false }, undefined]]) {
        const saved = [];
        const stopped = await generateModel3d({ provider: abortWith(fields), request: { format: 'fbx' }, wait, onHandle: handle => saved.push(handle) })
            .catch(error => error);
        assert.deepEqual([stopped.name, stopped.handle.advancing, saved.at(-1).advancing], ['AbortError', marker, marker], JSON.stringify(fields));
    }
});

test('an error from onHandle never loses the task ID, and a failed later stage points back at the paid one', async () => {
    const boom = new Error('disk full');
    const atSubmit = fakeProvider();
    const first = await generateModel3d({ provider: atSubmit, request: { format: 'fbx' }, wait, onHandle: () => { throw boom; } }).catch(error => error);
    assert.deepEqual([first, first.handle.taskId, atSubmit.log], [boom, 'gen-1', ['submit']]);

    // Saving the convert task fails: the error still names the new, billed task.
    const afterAdvance = fakeProvider();
    let saves = 0;
    const second = await generateModel3d({ provider: afterAdvance, request: { format: 'fbx' }, wait,
        onHandle: () => { saves += 1; if (saves === 3) throw boom; } }).catch(error => error);
    assert.deepEqual([second, second.handle.taskId, afterAdvance.log.at(-1)], [boom, 'conv-1', 'advance']);

    // Clearing the marker fails: the provider's rejection is still what the caller sees.
    const rejected = fakeProvider({ advance: () => { throw model3dError('credits', 'Fake'); } });
    saves = 0;
    const third = await generateModel3d({ provider: rejected, request: { format: 'fbx' }, wait,
        onHandle: () => { saves += 1; if (saves === 3) throw boom; } }).catch(error => error);
    assert.deepEqual([third.code, third.handle.taskId, third.handle.advancing], ['MODEL3D_INSUFFICIENT_CREDITS', 'gen-1', undefined]);

    // The convert task fails at the provider: only the convert needs to be submitted again.
    const failing = fakeProvider({ queries: { 'conv-1': [status('failed', [], { error: { code: 'x', message: 'bad', retryable: true } })] } });
    const fourth = await generateModel3d({ provider: failing, request: { format: 'fbx' }, wait }).catch(error => error);
    assert.deepEqual([fourth.code, fourth.handle.taskId, fourth.retryHandle.taskId, fourth.retryHandle.next.stage, fourth.retryHandle.advancing],
        ['MODEL3D_TASK_FAILED', 'conv-1', 'gen-1', 'convert', undefined]);
    const retried = await resumeModel3d({ provider: fakeProvider(), handle: fourth.retryHandle, wait });
    assert.equal(retried.handle.taskId, 'conv-1');
    // A first stage that fails has nothing to go back to.
    const early = fakeProvider({ queries: { 'gen-1': [status('failed')] } });
    assert.equal('retryHandle' in await generateModel3d({ provider: early, request: {}, wait }).catch(error => error), false);
});

test('remote failure and cancellation carry the handle and the provider reason, and never advance', async () => {
    const failed = fakeProvider({ queries: { 'gen-1': [status('failed', [], { error: { code: 'image_too_complex', message: '太复杂', retryable: false } })] } });
    const failure = await generateModel3d({ provider: failed, request: { format: 'fbx' }, wait }).catch(error => error);
    assert.deepEqual([failure.code, failure.confirmedFailure, failure.retryable, failure.remoteCode, failure.handle.taskId, failure.status.state],
        ['MODEL3D_TASK_FAILED', true, false, 'image_too_complex', 'gen-1', 'failed']);
    assert.match(failure.message, /太复杂/);
    assert.deepEqual(failed.log, ['submit', 'query:gen-1']);

    const retryable = fakeProvider({ queries: { 'gen-1': [status('failed', [], { error: { code: 'timeout', message: 'x', retryable: true } })] } });
    assert.equal((await generateModel3d({ provider: retryable, request: {}, wait }).catch(error => error)).retryable, true);
    const canceled = fakeProvider({ queries: { 'gen-1': [status('canceled')] } });
    assert.equal((await generateModel3d({ provider: canceled, request: {}, wait }).catch(error => error)).code, 'MODEL3D_TASK_CANCELED');
});

test('a submit failure propagates untouched and nothing else runs', async () => {
    const provider = fakeProvider();
    provider.submit = async () => { provider.log.push('submit'); throw model3dError('submissionUnknown', 'Fake'); };
    const handles = [];
    await assert.rejects(generateModel3d({ provider, request: {}, wait, onHandle: handle => handles.push(handle) }), { code: 'MODEL3D_SUBMISSION_UNKNOWN' });
    assert.deepEqual([provider.log, handles], [['submit'], []]);
});

test('downloads: a failed model download keeps the handle, extra files are best effort, and no saveDir means no download', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model3d-run-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const single = () => fakeProvider({ stages: false });
    const broken = await generateModel3d({ provider: single(), request: { format: 'glb' }, wait, saveDir: dir,
        fetchImpl: async () => new Response('expired', { status: 403 }) }).catch(error => error);
    assert.deepEqual([broken.code, broken.handle.taskId, broken.status.state], ['MODEL3D_DOWNLOAD_FAILED', 'gen-1', 'succeeded']);

    const all = await generateModel3d({ provider: single(), request: { format: 'glb' }, wait, saveDir: dir, baseName: 'lamp', download: 'all',
        fetchImpl: async url => (url.includes('preview') ? new Response('no', { status: 404 }) : new Response('model')) });
    assert.deepEqual(all.files.map(file => path.relative(dir, file.path).replace(/\\/g, '/')), ['lamp/model.glb']);
    const both = await generateModel3d({ provider: single(), request: { format: 'glb' }, wait, saveDir: dir, baseName: 'desk', download: 'all',
        fetchImpl: async () => new Response('data') });
    // Companion files keep the provider's names in one folder, so references between them still resolve.
    assert.deepEqual(both.files.map(file => path.relative(dir, file.path).replace(/\\/g, '/')), ['desk/model.glb', 'desk/preview.png']);
    const named = fakeProvider({ stages: false, queries: { 'gen-1': [status('succeeded', [
        { role: 'model', format: 'obj', url: 'https://cdn.test/dl/abc?sig=1', name: 'base_basic_pbr.obj' },
        { role: 'model', format: 'mtl', url: 'https://cdn.test/out/model.mtl?sig=1', name: 'mtl' },
        { role: 'texture', format: 'png', url: 'https://cdn.test/out/texture_0.png?sig=1', name: 'base_color' }])] } });
    const set = await generateModel3d({ provider: named, request: { format: 'obj' }, wait, saveDir: dir, baseName: 'a/b', download: 'all',
        fetchImpl: async () => new Response('data') });
    assert.deepEqual(set.files.map(file => path.relative(dir, file.path).replace(/\\/g, '/')),
        ['a_b/base_basic_pbr.obj', 'a_b/model.mtl', 'a_b/texture_0.png']);

    let fetches = 0;
    const none = await generateModel3d({ provider: single(), request: { format: 'glb' }, wait, fetchImpl: async () => { fetches += 1; return new Response('x'); } });
    assert.deepEqual([none.files, fetches, none.outputs.length], [[], 0, 2]);

    const empty = fakeProvider({ stages: false, queries: { 'gen-1': [status('succeeded', [thumb])] } });
    await assert.rejects(generateModel3d({ provider: empty, request: {}, wait, saveDir: dir, fetchImpl: async () => new Response('x') }),
        { code: 'MODEL3D_INVALID_RESPONSE' });
});

test('resume rejects a handle from another provider, and query, cancel and balance pass through', async () => {
    const provider = fakeProvider();
    // A record that does not match says nothing about its task, so it is not a confirmed failure.
    await assert.rejects(resumeModel3d({ provider, handle: { provider: 'meshy', taskId: 'x' }, wait }),
        { code: 'MODEL3D_INVALID_REQUEST', confirmedFailure: false });
    await assert.rejects(resumeModel3d({ provider, handle: { provider: 'fake' }, wait }), { code: 'MODEL3D_INVALID_REQUEST' });
    const handle = { provider: 'fake', taskId: 'gen-1', stage: 'generate', format: 'glb', next: null, history: [] };
    assert.equal((await queryModel3d({ provider, handle })).state, 'succeeded');
    assert.deepEqual(await cancelModel3d({ provider, handle }), { supported: false, canceled: false, detail: '' });
    assert.equal((await getModel3dBalance({ provider })).balance, 42);
});
