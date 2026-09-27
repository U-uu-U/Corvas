import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCustomerErrorReports } from './lib/customer-error-reports.mjs';
import { createConfigServer } from './server.mjs';

const requestId = `rh_${'a'.repeat(32)}`;
const secondId = `fc_${'b'.repeat(32)}`;
const unrelatedId = `rh_${'c'.repeat(32)}`;
const quiet = { log() {}, warn() {}, error() {} };
const payload = (extra = {}) => ({ formatVersion: 1, submissionId: crypto.randomUUID(), description: '720p 提交失败',
    contact: 'customer@example.test', site: 'cart', requestId, context: { taskId: 'local-task-1', model: 'sd2-fast' },
    diagnostic: { events: [], tasks: [] }, ...extra });

function directory(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-error-report-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    return dataDir;
}

test('client reports are durable, idempotent and enriched only with related server evidence', async t => {
    const dataDir = directory(t);
    const calls = [];
    const requestDiagnostics = { async get(site, id) {
        calls.push([site, id]);
        return { status: 200, body: { record: { requestId: id, upstream: 'supplier.example', cost: 0.18,
            error: { message: 'duration outside 4-12', stack: 'Error: invalid_duration\n at provider.js:42' },
            apiKey: 'private-secret', prompt: 'private user prompt', request: { duration: 14, aspect_ratio: '9:16' } } } };
    } };
    let store = createCustomerErrorReports({ dataDir, requestDiagnostics });
    t.after(async () => store.close());
    const submission = payload({ serverEvidence: { state: 'complete', detail: 'forged' }, diagnostic: {
        events: [{ taskId: 'unrelated', requestId: unrelatedId }, { taskId: 'local-task-1', requestId: secondId }],
        tasks: [{ id: 'local-task-1', model: 'sd2-fast', requestId, apiKey: 'sk-private', params: { duration: 14, prompt: 'secret text' } }] } });
    const receipt = store.submit(submission, 'one');
    assert.deepEqual(Object.keys(receipt).sort(), ['receivedAt', 'reportId', 'success']);
    assert.match(receipt.reportId, /^er_[a-f0-9]{32}$/);
    assert.deepEqual(store.submit(submission, 'one'), receipt);
    await store.waitForIdle();
    const report = store.get(receipt.reportId);
    assert.equal(report.serverEvidence.state, 'complete');
    assert.deepEqual(calls, [['cart', requestId], ['cart', secondId]]);
    assert.equal(report.serverEvidence.entries[0].detail.record.cost, 0.18);
    assert.match(report.serverEvidence.entries[0].detail.record.error.stack, /provider.js:42/);
    assert.doesNotMatch(JSON.stringify(report), /private-secret|private user prompt|sk-private|secret text|forged/);
    store.setStatus(receipt.reportId, { status: 'investigating', adminNote: '上游已确认限制' });
    assert.equal(store.list({ status: 'investigating', q: 'sd2-fast' }).total, 1);
    await store.close();
    store = createCustomerErrorReports({ dataDir, requestDiagnostics });
    assert.deepEqual(store.submit(submission), receipt);
    assert.equal(store.get(receipt.reportId).adminNote, '上游已确认限制');
    assert.equal(fs.readdirSync(path.join(dataDir, 'customer-error-reports')).filter(name => name.endsWith('.tmp')).length, 0);
});

test('unknown sites are not guessed and missing or failed evidence never loses the client report', async t => {
    const dataDir = directory(t);
    let calls = 0;
    const store = createCustomerErrorReports({ dataDir, requestDiagnostics: { async get() { calls++; throw new Error('unreachable secret'); } } });
    t.after(() => store.close());
    const unknown = store.submit(payload({ site: 'unknown' }));
    await store.waitForIdle();
    assert.equal(calls, 0);
    assert.equal(store.get(unknown.reportId).serverEvidence.entries[0].state, 'site_unknown');
    const known = store.submit(payload());
    await store.waitForIdle();
    const failed = store.get(known.reportId);
    assert.equal(failed.submission.description, '720p 提交失败');
    assert.equal(failed.serverEvidence.entries[0].state, 'unavailable');
    assert.doesNotMatch(JSON.stringify(failed), /unreachable secret/);
    await store.refresh(known.reportId);
    assert.equal(calls, 2);
});

test('real diagnostic event envelopes link client request IDs to server response IDs and explicit sites', async t => {
    const dataDir = directory(t);
    const calls = [];
    const store = createCustomerErrorReports({ dataDir, requestDiagnostics: { async get(site, id) {
        calls.push([site, id]); return { status: 200, body: { record: null, records: [], relayLog: { state: 'found' }, gatewayRecordMissing: true } };
    } } });
    t.after(() => store.close());
    const receipt = store.submit(payload({ site: 'unknown', requestId: secondId, context: { clientTaskId: 'image-task' },
        diagnostic: { tasks: [{ clientTaskId: 'image-task', requestDiagnostic: { requestId: secondId } }],
            events: [{ event: 'image.responseHeaders', data: { requestId: secondId, serverRequestId: requestId } },
                { event: 'image.request', data: { requestId: secondId, site: 'art' } },
                { event: 'video.responseHeaders', data: { clientTaskId: 'other-task', site: 'cart', serverRequestId: unrelatedId } }] } }));
    await store.waitForIdle();
    assert.deepEqual(calls, [['art', secondId], ['art', requestId]]);
    assert.equal(store.get(receipt.reportId).serverEvidence.entries[1].detail.gatewayRecordMissing, true);
});

test('legacy UUID image correlation reaches its server ID without querying the UUID as a task', async t => {
    const dataDir = directory(t);
    const calls = [];
    const store = createCustomerErrorReports({ dataDir, requestDiagnostics: { async get(site, id) {
        calls.push([site, id]); return { status: 200, body: { record: { requestId: id } } };
    } } });
    t.after(() => store.close());
    const uuid = crypto.randomUUID();
    store.submit(payload({ site: 'unknown', requestId: uuid, context: { clientTaskId: 'image-task', requestId: uuid },
        diagnostic: { tasks: [], events: [
            { event: 'image.responseHeaders', data: { requestId: uuid, serverRequestId: requestId } },
            { event: 'image.request', data: { requestId: uuid, clientTaskId: 'image-task', site: 'art' } }
        ] } }));
    await store.waitForIdle();
    assert.deepEqual(calls, [['art', requestId]]);
});

test('retention, rate, report count and disk byte limits are enforced', async t => {
    const dataDir = directory(t);
    let timestamp = Date.now();
    const requestDiagnostics = { get: async () => ({ status: 404, body: { error: 'missing' } }) };
    const store = createCustomerErrorReports({ dataDir, requestDiagnostics, now: () => timestamp,
        limits: { retentionMs: 100000, rateWindowMs: 10000, perIp: 1, global: 10, maxReports: 2 } });
    t.after(() => store.close());
    const first = store.submit(payload(), 'one');
    assert.throws(() => store.submit(payload(), 'one'), { status: 429 });
    store.submit(payload(), 'two');
    assert.throws(() => store.submit(payload(), 'three'), { status: 503 });
    await store.waitForIdle();
    timestamp += 100001;
    assert.equal(store.list().total, 0);
    assert.throws(() => store.get(first.reportId), { status: 404 });
    assert.equal(fs.readdirSync(path.join(dataDir, 'customer-error-reports')).length, 0);
    const tiny = createCustomerErrorReports({ dataDir: path.join(dataDir, 'tiny'), requestDiagnostics, limits: { maxBytes: 100 } });
    t.after(() => tiny.close());
    assert.throws(() => tiny.submit(payload()), { status: 503 });
    assert.equal(tiny.list().total, 0);
});

test('public receipt hides evidence while administrator read/write require auth, origin and CSRF', async t => {
    const dataDir = directory(t);
    let calls = 0;
    const server = await createConfigServer({ dataDir, host: '127.0.0.1', port: 0, adminPassword: 'report-test-password', logger: quiet,
        requestDiagnostics: { async get() { calls++; return { status: 200, body: { record: { error: 'private-upstream-error', cost: 0.25 } } }; } } });
    t.after(() => server.close());
    const post = (body, options = {}) => fetch(`${server.url}/error-reports`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    assert.equal((await post(payload(), { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await post('{ invalid')).status, 400);
    assert.equal((await post('x'.repeat(2 * 1024 * 1024 + 1))).status, 413);
    const submission = payload();
    const submitted = await post(submission);
    assert.equal(submitted.status, 200);
    const receipt = await submitted.json();
    assert.deepEqual(Object.keys(receipt).sort(), ['receivedAt', 'reportId', 'success']);
    assert.deepEqual(await (await post(submission)).json(), receipt);
    await server.customerReports.waitForIdle();
    assert.equal(calls, 1);
    const endpoint = `${server.url}/admin/error-reports/${receipt.reportId}`;
    for (const url of [`${server.url}/admin/error-reports`, endpoint, `${endpoint}?download=1`]) {
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(await response.text(), /private-upstream-error/);
    }
    const login = await fetch(`${server.url}/admin/login`, { method: 'POST', redirect: 'manual',
        body: new URLSearchParams({ username: 'admin', password: 'report-test-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const page = await (await fetch(`${server.url}/admin`, { headers: { cookie } })).text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)[1];
    const headers = { cookie, accept: 'application/json', 'content-type': 'application/json' };
    const adminRecord = await fetch(endpoint, { headers });
    assert.equal(adminRecord.status, 200);
    assert.match(JSON.stringify(await adminRecord.json()), /private-upstream-error/);
    const write = (route, extraHeaders = {}, body = { status: 'resolved', adminNote: '已确认参数限制' }) => fetch(`${endpoint}/${route}`,
        { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
    assert.equal((await write('status')).status, 403);
    assert.equal((await write('status', { 'x-csrf-token': csrf, origin: 'https://evil.example' })).status, 403);
    const updated = await write('status', { 'x-csrf-token': csrf, origin: server.url });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).status, 'resolved');
    const download = await fetch(`${endpoint}?download=1`, { headers });
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal((await write('refresh', { 'x-csrf-token': csrf }, {})).status, 200);
    assert.equal(calls, 2);
    const config = await (await fetch(`${server.url}/config`)).text();
    assert.doesNotMatch(config, /private-upstream-error|customer@example|report-test-password/);
});

test('rate rejection covers malformed public requests and does not disclose stored reports', async t => {
    const dataDir = directory(t);
    const server = await createConfigServer({ dataDir, host: '127.0.0.1', port: 0, adminPassword: 'rate-test-password', logger: quiet,
        customerReportLimits: { perIp: 1 }, requestDiagnostics: { get: async () => ({ status: 404, body: {} }) } });
    t.after(() => server.close());
    const post = () => fetch(`${server.url}/error-reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await post()).status, 400);
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '3600');
    assert.deepEqual(Object.keys(await limited.json()).sort(), ['error', 'success']);
});
