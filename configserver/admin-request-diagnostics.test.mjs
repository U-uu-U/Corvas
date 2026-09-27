import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAdminRequestDiagnostics } from './lib/admin-request-diagnostics.mjs';
import { createConfigServer } from './server.mjs';
import { hashPassword } from './lib/auth.mjs';

const id = 'rh_' + 'a'.repeat(32);
test('diagnostic connector fixes host, keeps credentials server-side and refuses invalid lookup', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-admin-diagnostics-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const key = 'private-diagnostic-token'.repeat(3);
    fs.writeFileSync(path.join(dataDir, 'admin-diagnostics-credentials.json'), JSON.stringify({ art: { key, url: 'https://evil.example' } }));
    let calls = 0;
    const reader = createAdminRequestDiagnostics({ dataDir, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(new URL(url).host, 'art.ravenhash.org');
        assert.equal(new URL(url).searchParams.get('requestId'), id);
        assert.equal(options.headers['x-corvas-diagnostics-key'], key);
        assert.equal(options.redirect, 'error');
        return new Response(JSON.stringify({ record: { requestId: id, upstreamError: 'diagnostic reason' } }));
    } });
    assert.equal((await reader.get('evil', id)).status, 400);
    assert.equal((await reader.get('art', '../secrets')).status, 400);
    assert.equal(calls, 0);
    const result = await reader.get('art', id);
    assert.equal(result.status, 200);
    assert.doesNotMatch(JSON.stringify(result), /private-diagnostic-token|evil/);
});

test('administrator authentication is required before any diagnostic lookup', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-admin-diagnostics-auth-'));
    let calls = 0;
    const server = await createConfigServer({ dataDir, host: '127.0.0.1', port: 0,
        passwordRecord: hashPassword('diagnostic-test-password'), logger: { log() {}, warn() {}, error() {} },
        requestDiagnostics: { async get() { calls++; return { status: 200, body: { record: { private: 'admin-only' } } }; } } });
    t.after(async () => { await server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const url = `${server.url}/admin/request-diagnostics?site=art&requestId=${id}`;
    const denied = await fetch(url, { headers: { accept: 'application/json' } });
    assert.equal(denied.status, 401);
    assert.equal(calls, 0);
    assert.doesNotMatch(await denied.text(), /admin-only/);
    const login = await fetch(`${server.url}/admin/login`, { method: 'POST', redirect: 'manual',
        body: new URLSearchParams({ username: 'admin', password: 'diagnostic-test-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const allowed = await fetch(url, { headers: { cookie, accept: 'application/json' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('cache-control'), 'no-store');
    assert.equal((await allowed.json()).record.private, 'admin-only');
    assert.equal(calls, 1);
    assert.equal((await fetch(`${server.url}/admin-diagnostics-credentials.json`)).status, 404);
});

test('client correlation queries exact fc IDs and accepts relay-only evidence without a gateway record', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-admin-diagnostics-client-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const clientId = 'fc_' + 'b'.repeat(32);
    fs.writeFileSync(path.join(dataDir, 'admin-diagnostics-credentials.json'), JSON.stringify({ cart: { key: 'diagnostic-test-key'.repeat(3) } }));
    let calls = 0;
    const reader = createAdminRequestDiagnostics({ dataDir, fetchImpl: async url => {
        calls++;
        assert.equal(new URL(url).host, 'cart.ravenhash.org');
        assert.equal(new URL(url).searchParams.get('requestId'), clientId);
        assert.equal(new URL(url).searchParams.get('includeRelayLog'), '1');
        return new Response(JSON.stringify({ record: null, records: [], gatewayRecordMissing: true,
            relayLog: { state: 'found', billingState: 'unknown', rows: [{ log_id: clientId, cost: 2.3 }] } }));
    } });
    for (const value of ['fc_abcdefgh', clientId + 'c', clientId.toUpperCase(), 'task-only-id']) {
        assert.equal((await reader.get('cart', value)).status, 400);
    }
    assert.equal(calls, 0);
    const result = await reader.get('cart', clientId);
    assert.equal(result.status, 200);
    assert.equal(result.body.record.record, null);
    assert.equal(result.body.record.gatewayRecordMissing, true);
    assert.equal(result.body.record.relayLog.rows[0].log_id, clientId);
    assert.equal(calls, 1);
});
