const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createErrorReportClient, safeRequestParameters, errorReportContext, classifyErrorReportSite, ERROR_REPORT_URL } = require('./error-report-client.cjs');

const reportId = `er_${'a'.repeat(32)}`;
const receivedAt = '2026-09-27T12:00:00.000Z';
const receipt = () => new Response(JSON.stringify({ success: true, reportId, receivedAt, upstream: 'must-not-return' }));
const diagnostic = () => ({ events: [], tasks: [], environment: { app: '1.6.0' } });
const input = () => ({ submissionId: crypto.randomUUID(), description: 'fixture', site: 'cart', requestId: `rh_${'b'.repeat(32)}`, context: {} });

test('submission fixes destination, strips secrets/media, and only returns receipt', async () => {
    let request;
    const client = createErrorReportClient({ getReport: async () => ({ ...diagnostic(), config: { revision: 41 },
        events: [{ data: { apiKey: 'private-key', prompt: 'private prompt', imageUrls: ['https://media.test/private.png'],
            message: 'private-key failed', duration: 12 } }] }), getSecrets: () => ['private-key'],
    fetchImpl: async (...args) => { request = args; return receipt(); } });
    const result = await client.submit({ ...input(), url: 'https://evil.test', diagnostic: { token: 'forged' } });
    assert.deepEqual(result, { success: true, reportId, receivedAt });
    assert.equal(request[0], ERROR_REPORT_URL);
    assert.equal(request[1].redirect, 'error');
    assert.equal(request[1].method, 'POST');
    assert.equal(request[1].body.includes('private-key'), false);
    assert.equal(request[1].body.includes('private prompt'), false);
    assert.equal(request[1].body.includes('private.png'), false);
    assert.equal(request[1].body.includes('forged'), false);
    assert.equal(JSON.parse(request[1].body).diagnostic.config.revision, 41);
});

test('manual retry preserves exact submission snapshot and successful receipts deduplicate', async () => {
    const bodies = [];
    let reports = 0;
    const client = createErrorReportClient({ getReport: () => ({ ...diagnostic(), sessionId: String(++reports) }),
        fetchImpl: async (_url, options) => {
            bodies.push(options.body);
            if (bodies.length === 1) throw new Error('network lost');
            return receipt();
        } });
    const draft = input();
    await assert.rejects(() => client.submit(draft), /无法连接/);
    assert.equal(bodies.length, 1);
    await client.submit({ ...draft, description: 'changed after failure' });
    await client.submit(draft);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(reports, 1);
});

test('JSON problem descriptions retain useful fields while filtering private input', async () => {
    let payload;
    const client = createErrorReportClient({ getReport: diagnostic, fetchImpl: async (_url, options) => {
        payload = JSON.parse(options.body);
        return receipt();
    } });
    await client.submit({ ...input(), description: '{"duration":15,"prompt":"private fixture"}' });
    assert.match(payload.description, /15/);
    assert.equal(payload.description.includes('private fixture'), false);
});

test('concurrent duplicate submits send only one request', async () => {
    let requests = 0;
    const client = createErrorReportClient({ getReport: async () => diagnostic(), fetchImpl: async () => {
        requests++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return receipt();
    } });
    const draft = input();
    await Promise.all([client.submit(draft), client.submit(draft)]);
    assert.equal(requests, 1);
});

test('server errors are not echoed and never retried automatically', async () => {
    let requests = 0;
    const client = createErrorReportClient({ getReport: diagnostic, fetchImpl: async () => {
        requests++;
        return new Response('sensitive upstream credentials', { status: 503 });
    } });
    await assert.rejects(() => client.submit(input()), error => /提交暂未完成/.test(error.message) && !/sensitive/.test(error.message));
    assert.equal(requests, 1);
});

test('timeout aborts request and reports retryable receipt uncertainty', async () => {
    const client = createErrorReportClient({ getReport: diagnostic, timeoutMs: 10, fetchImpl: async (_url, options) => {
        return new Promise((_, reject) => {
            const keepAlive = setTimeout(() => reject(new Error('test deadline')), 1000);
            options.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('aborted')); });
        });
    } });
    await assert.rejects(() => client.submit(input()), /提交超时/);
});

test('malformed and oversized receipts are rejected', async () => {
    for (const response of [new Response('not json'), new Response(JSON.stringify({ success: true, reportId: 'unsafe', receivedAt })),
        new Response('x'.repeat(17000))]) {
        const client = createErrorReportClient({ getReport: diagnostic, fetchImpl: async () => response });
        await assert.rejects(() => client.submit(input()), /回执格式异常/);
    }
});

test('oversized diagnostic fails locally before network', async () => {
    let requests = 0;
    const client = createErrorReportClient({ getReport: () => ({ ...diagnostic(), events: Array.from({ length: 100 }, () => ({ message: 'x '.repeat(16000) })) }),
        fetchImpl: async () => { requests++; return receipt(); } });
    await assert.rejects(() => client.submit(input()), /诊断报告过大/);
    assert.equal(requests, 0);
});

test('invalid renderer submission is rejected before collecting report', async () => {
    let reports = 0;
    const client = createErrorReportClient({ getReport: () => { reports++; return diagnostic(); } });
    await assert.rejects(() => client.submit({ submissionId: 'bad' }), /提交编号无效/);
    assert.equal(reports, 0);
});

test('safe parameter context retains numeric controls and reference counts without input content', () => {
    assert.deepEqual(safeRequestParameters({ ratio: '9:16', duration: 12, resolution: '720p', quality: 'https://private.test',
        prompt: 'private', apiKey: 'private', sourceReferences: [{ kind: 'image', url: 'private' }, { type: 'video' }] }),
    { ratio: '9:16', duration: 12, resolution: '720p', referenceCount: 2, imageReferenceCount: 1, videoReferenceCount: 1, audioReferenceCount: 0 });
    const context = errorReportContext({ time: receivedAt, event: 'ipc.throw', data: { model: 'sd2-fast', site: 'cart',
        error: { requestId: 'rh_fixture123', message: 'Failed', category: 'parameters' }, parameters: { duration: 12 } } });
    assert.equal(context.requestId, 'rh_fixture123');
    assert.equal(context.site, 'cart');
    assert.equal(context.category, 'parameters');
    assert.deepEqual(context.params, { duration: 12 });
    assert.equal(classifyErrorReportSite('https://cart.ravenhash.org/v1'), 'cart');
    assert.equal(classifyErrorReportSite('https://cart.ravenhash.org.evil.test/v1'), 'unknown');
});

test('restart recovers the exact pending body and persists its receipt without collecting diagnostics again', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-report-cache-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const draft = { ...input(), contact: 'fixture@example.invalid', context: { clientTaskId: 'client-fixture', model: 'sd2-fast' } };
    const bodies = [];
    const beforeRestart = createErrorReportClient({ directory, getReport: diagnostic, fetchImpl: async (_url, options) => {
        bodies.push(options.body);
        throw new Error('Receipt lost after server accepted');
    } });
    await assert.rejects(() => beforeRestart.submit(draft), /无法连接/);
    const afterRestart = createErrorReportClient({ directory, getReport: () => { throw new Error('Must not collect a replacement report'); },
        fetchImpl: async (_url, options) => { bodies.push(options.body); return receipt(); } });
    const saved = afterRestart.summary().submissions[0];
    assert.equal(saved.submissionId, draft.submissionId);
    assert.equal(saved.state, 'pending');
    assert.equal(saved.context.clientTaskId, 'client-fixture');
    assert.equal(saved.contact, 'fixture@example.invalid');
    assert.equal('diagnostic' in saved, false);
    assert.equal('body' in saved, false);
    await afterRestart.submit({ submissionId: saved.submissionId, directory: path.join(directory, 'ignored-renderer-path') });
    assert.equal(bodies[0], bodies[1]);
    const withReceipt = createErrorReportClient({ directory, fetchImpl: async () => { throw new Error('Must use receipt'); } });
    assert.deepEqual(await withReceipt.submit({ submissionId: draft.submissionId }), { success: true, reportId, receivedAt });
    assert.equal(withReceipt.summary().submissions[0].state, 'received');
    assert.deepEqual(fs.readdirSync(directory), [`${draft.submissionId}.json`]);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(directory, `${draft.submissionId}.json`)).mode & 0o777, 0o600);
    }
});

test('the persistent store bounds completed reports to 30 and leaves no temporary files', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-report-retention-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const client = createErrorReportClient({ directory, getReport: diagnostic, fetchImpl: async () => receipt() });
    for (let index = 0; index < 32; index++) await client.submit(input());
    assert.equal(fs.readdirSync(directory).length, 30);
    assert.equal(client.summary().submissions.length, 30);
    assert.equal(createErrorReportClient({ directory }).summary().submissions.length, 30);
});

test('pending records are not evicted and a failed disk write never sends a report', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-report-pending-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let requests = 0;
    const client = createErrorReportClient({ directory, getReport: diagnostic, fetchImpl: async () => {
        requests++;
        throw new Error('offline');
    } });
    for (let index = 0; index < 30; index++) await assert.rejects(() => client.submit(input()), /无法连接/);
    await assert.rejects(() => client.submit(input()), /提交记录已满/);
    assert.equal(requests, 30);
    assert.equal(fs.readdirSync(directory).length, 30);
    const badDirectory = path.join(directory, 'not-a-directory');
    fs.writeFileSync(badDirectory, 'fixture');
    const broken = createErrorReportClient({ directory: badDirectory, getReport: diagnostic,
        fetchImpl: async () => { requests++; return receipt(); } });
    await assert.rejects(() => broken.submit(input()), /提交记录读取失败/);
    assert.equal(requests, 30);
});
