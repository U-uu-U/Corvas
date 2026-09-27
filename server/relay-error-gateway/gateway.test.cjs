const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createGateway, validTarget, metadataFromBody } = require('./gateway.cjs');
const { createDiagnosticsStore, sanitizePrivate } = require('./diagnostics-store.cjs');

const SECRET = 'diagnostics-test-key-32-chars-minimum';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
function request(port, target, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const outgoing = http.request({ hostname: '127.0.0.1', port, path: target, method, headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => {
                const bytes = Buffer.concat(chunks);
                let json;
                try { json = JSON.parse(bytes); } catch { /* Binary or streaming fixture. */ }
                resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString(), json });
            });
        });
        outgoing.on('error', reject);
        outgoing.end(body);
    });
}
async function fixture(t, handler, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-error-gateway-'));
    const upstream = http.createServer(handler);
    const upstreamPort = await listen(upstream);
    const gateway = createGateway({ diagnosticsKey: SECRET, recordsDirectory: directory,
        upstreamRequest(url, requestOptions, callback) {
            assert.equal(url.origin, 'http://127.0.0.1:8080');
            url.port = upstreamPort;
            return http.request(url, requestOptions, callback);
        }, ...options });
    const port = await listen(gateway);
    t.after(async () => { await close(gateway); await close(upstream); fs.rmSync(directory, { recursive: true, force: true }); });
    return { directory, port, admin: id => request(port, `/internal/diagnostics?requestId=${id}`, { headers: { 'x-corvas-diagnostics-key': SECRET } }) };
}

test('forwards exact successful request and response without saving credentials or bodies', async t => {
    const body = JSON.stringify({ model: 'sd2-fast', prompt: 'sensitive private prompt', image_urls: ['https://private.example/media?token=abc'] });
    let calls = 0, upstreamId;
    const f = await fixture(t, (req, res) => {
        calls++;
        assert.equal(req.url, '/v1/video/generations?test=1');
        assert.equal(req.headers.authorization, 'Bearer sk-secret-api-key');
        assert.equal(req.headers['x-corvas-diagnostics-key'], undefined);
        upstreamId = req.headers['x-log-id'];
        assert.match(upstreamId, /^rh_[a-f0-9]{32}$/);
        assert.notEqual(upstreamId, 'caller-id');
        let bytes = '';
        req.on('data', chunk => { bytes += chunk; });
        req.on('end', () => {
            assert.equal(bytes, body);
            res.writeHead(202, { 'content-type': 'application/json', 'x-custom': 'unchanged' });
            res.end('{ "task_id": "job-1", "status": "queued" }');
        });
    });
    const response = await request(f.port, '/v1/video/generations?test=1', { method: 'POST', body,
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-secret-api-key', 'x-request-id': 'caller-id', 'x-corvas-diagnostics-key': SECRET } });
    assert.equal(response.status, 202);
    assert.equal(response.text, '{ "task_id": "job-1", "status": "queued" }');
    assert.equal(response.headers['x-request-id'], upstreamId);
    assert.equal(response.headers['x-custom'], 'unchanged');
    assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(f.directory), []);
    assert.equal((await f.admin(upstreamId)).status, 404);
});

test('preserves valid legacy and relay log IDs without reusing them as gateway request IDs', async t => {
    const forwarded = [];
    const f = await fixture(t, (req, res) => {
        req.resume();
        forwarded.push(req.headers['x-log-id']);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('{"task_id":"real-task","status":"queued"}');
    });
    for (const logId of [`fc_${'a'.repeat(32)}`, `rh_${'b'.repeat(32)}`, 'invalid-caller-id', `fc_${'c'.repeat(33)}`]) {
        const response = await request(f.port, '/v1/video/generations', { method: 'POST', body: '{}',
            headers: { 'content-type': 'application/json', 'x-log-id': logId } });
        const requestId = response.headers['x-request-id'];
        assert.match(requestId, /^rh_[a-f0-9]{32}$/);
        assert.notEqual(requestId, logId);
        assert.equal(forwarded.at(-1), /^(?:fc|rh)_[a-f0-9]{32}$/.test(logId) ? logId : requestId);
        assert.equal(response.json.task_id, 'real-task');
    }
});

test('binary and SSE remain byte-identical streams; inspected success JSON is unchanged', async t => {
    const payloads = {
        '/v1/videos/job/content': { type: 'video/mp4', body: Buffer.from([0, 1, 255, 20, 0, 2]) },
        '/v1/videos/events': { type: 'text/event-stream', body: Buffer.from('data: {"status":"working"}\n\ndata: [DONE]\n\n') },
        '/v1/images/generations': { type: 'application/json', body: Buffer.from(JSON.stringify({ data: [{ b64_json: 'x'.repeat(32) }] })) }
    };
    const f = await fixture(t, (req, res) => { const value = payloads[req.url]; res.writeHead(200, { 'content-type': value.type }); res.write(value.body.subarray(0, 20)); res.end(value.body.subarray(20)); }, { maxResponseBytes: 128 });
    for (const [target, value] of Object.entries(payloads)) {
        const response = await request(f.port, target);
        assert.equal(response.status, 200);
        assert.deepEqual(response.bytes, value.body);
        assert.equal(response.headers['content-type'], value.type);
    }
    assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('oversized, malformed and undecodable 2xx JSON fail closed without retrying POST', async t => {
    const privateMarker = 'private-provider-cost-0.13-sk-private-key';
    const oversized = JSON.stringify({ status: 'failed', error: { message: privateMarker + 'x'.repeat(512) } });
    const payloads = {
        oversized: { body: Buffer.from(oversized) },
        inflated: { body: zlib.gzipSync(oversized), encoding: 'gzip' },
        malformed: { body: Buffer.from(`{"error":{"message":"${privateMarker}"`) },
        encoding: { body: Buffer.from(`{"error":"${privateMarker}"}`), encoding: 'unknown' },
        oversizedSuccess: { body: Buffer.from(JSON.stringify({ data: [{ b64_json: 'x'.repeat(512) }] })) }
    };
    let calls = 0;
    const f = await fixture(t, (req, res) => {
        calls++;
        req.resume();
        const payload = payloads[req.url.split('/').at(-1)];
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-cost': '0.13',
            ...(payload.encoding ? { 'content-encoding': payload.encoding } : {}) });
        res.end(payload.body);
    }, { maxResponseBytes: 128 });
    for (const kind of Object.keys(payloads)) {
        const response = await request(f.port, `/v1/video/${kind}`, { method: 'POST', body: '{}' });
        assert.equal(response.status, 502, kind);
        assert.equal(response.json.error.code, 'RH_SUBMISSION_UNKNOWN', kind);
        assert.equal(response.json.error.submissionState, 'unknown', kind);
        assert.equal(response.json.error.retryable, false, kind);
        assert.equal(response.json.task_id, undefined, kind);
        assert.equal(response.headers['content-encoding'], undefined, kind);
        assert.equal(response.headers['x-upstream-cost'], undefined, kind);
        assert.ok(!response.text.includes(privateMarker), kind);
        assert.equal((await f.admin(response.headers['x-request-id'])).status, 200, kind);
    }
    const polled = await request(f.port, '/v1/videos/oversized');
    assert.equal(polled.json.error.stage, 'poll');
    assert.equal(polled.json.error.action, 'retry_query');
    assert.equal(polled.json.error.confirmedFailure, false);
    assert.ok(!polled.text.includes(privateMarker));
    assert.equal(calls, Object.keys(payloads).length + 1);
});

test('bodyless successful responses do not require a JSON body', async t => {
    const f = await fixture(t, (req, res) => {
        res.writeHead(req.method === 'HEAD' ? 200 : 204, { 'content-type': 'application/json' });
        res.end();
    });
    const head = await request(f.port, '/v1/videos/exists', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    const empty = await request(f.port, '/v1/videos/empty');
    assert.equal(empty.status, 204);
    assert.equal(empty.text, '');
    assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('image JSON has a larger bounded allowance without exposing embedded task failures', async t => {
    const privateMarker = 'private-image-provider-cost-0.13';
    const image = JSON.stringify({ data: [{ b64_json: 'x'.repeat(1024 * 1024 + 64) }] });
    const failure = JSON.stringify({ status: 'failed', task_id: 'image-task', error: { message: privateMarker,
        debug: 'x'.repeat(1024 * 1024 + 64) } });
    let calls = 0;
    const f = await fixture(t, (req, res) => {
        calls++;
        req.resume();
        const body = req.url.includes('failed') ? failure : image;
        const compressed = req.url.endsWith('/gzip');
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-cost': '0.13',
            ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
        res.end(compressed ? zlib.gzipSync(body) : body);
    });
    for (const suffix of ['plain', 'gzip']) {
        const response = await request(f.port, `/v1/images/generations/${suffix}`, { method: 'POST', body: '{}' });
        assert.equal(response.status, 200);
        assert.equal(response.headers['content-encoding'], suffix === 'gzip' ? 'gzip' : undefined);
        const body = suffix === 'gzip' ? zlib.gunzipSync(response.bytes).toString() : response.text;
        assert.equal(body, image);
        const failed = await request(f.port, `/v1/images/failed/${suffix}`);
        assert.equal(failed.json.error.protocolVersion, 2);
        assert.equal(failed.json.error.confirmedFailure, true);
        assert.equal(failed.headers['x-upstream-cost'], undefined);
        assert.equal(failed.headers['content-encoding'], undefined);
        assert.ok(!failed.text.includes(privateMarker));
    }
    const video = await request(f.port, '/v1/videos/large', { method: 'POST', body: '{}' });
    assert.equal(video.json.error.code, 'RH_SUBMISSION_UNKNOWN');
    assert.equal(calls, 5);
});

test('configured image allowance bounds encoded and decompressed bodies while HTTP errors retain the small limit', async t => {
    const body = JSON.stringify({ data: [{ b64_json: 'x'.repeat(512) }] });
    let calls = 0;
    const f = await fixture(t, (req, res) => {
        calls++;
        req.resume();
        const compressed = req.url.endsWith('/gzip');
        const error = req.url.endsWith('/error');
        res.writeHead(error ? 400 : 200, { 'content-type': 'application/json',
            ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
        res.end(compressed ? zlib.gzipSync(body) : body);
    }, { maxResponseBytes: 64, maxImageResponseBytes: 256 });
    for (const suffix of ['plain', 'gzip']) {
        const response = await request(f.port, `/v1/images/generations/${suffix}`, { method: 'POST', body: '{}' });
        assert.equal(response.json.error.code, 'RH_SUBMISSION_UNKNOWN');
        assert.equal(response.json.error.retryable, false);
        assert.equal(response.headers['content-encoding'], undefined);
    }
    const error = await request(f.port, '/v1/images/error');
    assert.equal(error.status, 400);
    assert.equal(error.json.error.protocolVersion, 2);
    const diagnostic = await f.admin(error.headers['x-request-id']);
    assert.match(diagnostic.json.record.error.error.message, /inspection limit/);
    assert.equal(calls, 3);
});

test('2xx text or untyped responses cannot bypass failure inspection', async t => {
    const privateMarker = 'private-provider-price-0.13';
    const f = await fixture(t, (req, res) => {
        req.resume();
        const untyped = req.url.endsWith('/untyped');
        const plain = req.url.endsWith('/plain');
        res.writeHead(200, untyped ? {} : { 'content-type': 'text/plain' });
        res.end(plain ? privateMarker : JSON.stringify({ status: 'failed', task_id: 'real-task', error: { message: privateMarker } }));
    });
    for (const kind of ['json', 'untyped', 'plain']) {
        const response = await request(f.port, `/v1/videos/${kind}`);
        assert.equal(response.json.error.protocolVersion, 2, kind);
        assert.ok(!response.text.includes(privateMarker), kind);
        assert.equal(response.json.error.confirmedFailure, kind !== 'plain', kind);
    }
});

test('keeps provider details private, redacts prompts and credentials, and never retries POST', async t => {
    let calls = 0;
    const f = await fixture(t, (req, res) => {
        calls++;
        req.resume();
        res.writeHead(400, { 'content-type': 'application/json', 'x-provider-price': '0.08', 'set-cookie': 'api_key=secret' });
        res.end(JSON.stringify({ error: { code: 'duration_out_of_range', message: 'Provider A costs 0.08; duration between 1 and 12; received 15. Bearer sk-secret-user-key https://signed.example/file?token=secret very private prompt',
            prompt: 'very private prompt', image_url: 'https://signed.example/file?token=secret', api_key: '123456789' } }));
    });
    const response = await request(f.port, '/v1/video/generations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-real-client' },
        body: JSON.stringify({ model: 'sd2-fast', prompt: 'very private prompt', duration: 15, resolution: '720p', image_urls: ['https://signed.example/ref'] }) });
    assert.equal(calls, 1);
    assert.equal(response.status, 400);
    assert.equal(response.json.error.protocolVersion, 2);
    assert.equal(response.json.error.billingState, 'unknown');
    assert.equal(response.json.error.parameterIssues[0].max, 12);
    for (const secret of ['Provider A', '0.08', 'private prompt', 'sk-secret', 'signed.example', '123456789']) assert.ok(!response.text.includes(secret));
    assert.equal(response.headers['x-provider-price'], undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    const id = response.headers['x-request-id'];
    assert.equal((await request(f.port, `/internal/diagnostics?requestId=${id}`)).status, 404);
    assert.equal((await request(f.port, `/internal/diagnostics?requestId=${id}`, { headers: { 'x-corvas-diagnostics-key': 'wrong' } })).status, 404);
    const diagnostic = await f.admin(id);
    assert.equal(diagnostic.status, 200);
    assert.ok(diagnostic.text.includes('Provider A costs 0.08'));
    for (const secret of ['very private prompt', 'sk-secret', 'signed.example', '123456789']) assert.ok(!diagnostic.text.includes(secret));
    assert.equal(diagnostic.json.record.request.referenceCounts.images, 1);
    assert.equal(diagnostic.json.record.request.duration, 15);
    assert.equal(diagnostic.json.relayLog.state, 'unknown');
    const saved = fs.readFileSync(path.join(f.directory, `${id}.json`), 'utf8');
    assert.ok(!saved.includes('sk-real-client'));
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(f.directory, `${id}.json`)).mode & 0o777, 0o600);
    }
});

test('records failed GET tasks and keeps request correlation distinct from task IDs', async t => {
    const f = await fixture(t, (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed', request_id: 'vendor-request-only', ...(req.url.endsWith('known') ? { task_id: 'task-real-1' } : {}), error: { message: 'task failed at Vendor B' } }));
    });
    const result = await request(f.port, '/v1/videos/known');
    assert.equal(result.status, 200);
    assert.equal(result.json.task_id, 'task-real-1');
    assert.equal(result.json.error.confirmedFailure, true);
    const record = await f.admin(result.headers['x-request-id']);
    assert.equal(record.json.record.method, 'GET');
    assert.equal(record.json.record.taskId, 'task-real-1');
    assert.equal(record.json.record.responseIds.request_id, 'vendor-request-only');
    assert.ok(Number.isFinite(record.json.record.elapsedMs));
    assert.ok(record.json.record.completedAt >= record.json.record.createdAt);
    const missingTask = await request(f.port, '/v1/videos/unknown-id');
    assert.equal(missingTask.json.task_id, undefined);
    assert.equal(missingTask.json.id, undefined);
    assert.equal((await f.admin(missingTask.headers['x-request-id'])).json.record.taskId, null);
    assert.ok(!missingTask.text.includes('vendor-request-only'));
});

test('500 and lost POST response remain submission unknown without retry', async t => {
    let calls = 0;
    const f = await fixture(t, (req, res) => {
        calls++;
        req.resume();
        if (req.url.endsWith('disconnect')) return req.socket.destroy();
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"unexpected provider failure"}}');
    });
    for (const target of ['/v1/video/generations', '/v1/video/disconnect']) {
        const response = await request(f.port, target, { method: 'POST', body: '{}' });
        assert.equal(response.json.error.submissionState, 'unknown');
        assert.equal(response.json.error.code, 'RH_SUBMISSION_UNKNOWN');
        assert.equal(response.json.error.retryable, false);
        assert.equal(response.json.error.billingState, 'unknown');
    }
    assert.equal(calls, 2);
});

test('oversized JSON request is rejected before forwarding and oversized errors are safe', async t => {
    let calls = 0;
    const f = await fixture(t, (req, res) => { calls++; res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'sensitive'.repeat(100) } })); }, { maxRequestBytes: 32, maxResponseBytes: 64 });
    const rejected = await request(f.port, '/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'x'.repeat(80) }), headers: { 'content-type': 'application/json' } });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json.error.submissionState, 'not_submitted');
    assert.equal(calls, 0);
    const response = await request(f.port, '/v1/images/generations');
    assert.equal(response.status, 400);
    assert.ok(!response.text.includes('sensitive'));
    assert.equal(calls, 1);
});

test('compressed failures are normalized while compressed success bytes are preserved', async t => {
    const success = zlib.gzipSync('{"task_id":"job-1","status":"queued"}');
    const f = await fixture(t, (req, res) => {
        const failed = req.url.endsWith('failed');
        res.writeHead(failed ? 400 : 200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(failed ? zlib.gzipSync('{"error":{"message":"duration between 1 and 12"}}') : success);
    });
    const failed = await request(f.port, '/v1/videos/failed');
    assert.equal(failed.headers['content-encoding'], undefined);
    assert.equal(failed.json.error.parameterIssues[0].max, 12);
    const passed = await request(f.port, '/v1/videos/ok');
    assert.equal(passed.headers['content-encoding'], 'gzip');
    assert.deepEqual(passed.bytes, success);
});

test('compressed failed JSON and invalid compressed HTTP errors never expose the original response', async t => {
    const privatePayload = JSON.stringify({ status: 'failed', task_id: 'actual-task', error: { message: 'private provider price 0.13 Bearer sk-private-key' } });
    const f = await fixture(t, (req, res) => {
        const terminal = req.url.endsWith('terminal');
        res.writeHead(terminal ? 200 : 502, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-upstream-cost': '0.13' });
        res.end(terminal ? zlib.gzipSync(privatePayload) : Buffer.from(privatePayload));
    });
    const terminal = await request(f.port, '/v1/videos/terminal');
    assert.equal(terminal.status, 200);
    assert.equal(terminal.json.task_id, 'actual-task');
    assert.equal(terminal.json.error.confirmedFailure, true);
    const invalid = await request(f.port, '/v1/videos/invalid');
    assert.equal(invalid.status, 502);
    for (const response of [terminal, invalid]) {
        assert.equal(response.headers['content-encoding'], undefined);
        assert.equal(response.headers['x-upstream-cost'], undefined);
        for (const secret of ['private provider', '0.13', 'sk-private-key']) assert.ok(!response.text.includes(secret));
    }
});

test('rejects path injection and exact private lookup cannot be reached through v1', async t => {
    let calls = 0;
    const f = await fixture(t, (req, res) => { calls++; res.end('relay'); });
    for (const target of ['/v1/../internal/diagnostics', '/v1/%2e%2e/internal/diagnostics', '/v1/%2finternal/diagnostics', '//internal/diagnostics', 'http://evil.invalid/v1/videos', '/v1\\..\\internal/diagnostics']) {
        assert.equal((await request(f.port, target)).status, 404, target);
    }
    assert.equal(calls, 0);
    assert.equal(validTarget('/v1/%252e%252e/internal/diagnostics'), null);
    assert.throws(() => createGateway({ upstreamBase: 'https://remote.invalid', diagnosticsKey: SECRET }), /local relay/);
    assert.throws(() => createGateway({ diagnosticsKey: 'short' }), /32 characters/);
});

test('authenticated log enrichment is exact, private and sanitized; missing ledger is unknown', async t => {
    const lookups = [];
    const f = await fixture(t, (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"invalid request"}}'); }, {
        logReader: async id => { lookups.push(id); return { state: 'found', billingState: 'unknown', rows: [{ log_id: id, cost: 2.3, is_completed: 1, channel_name: 'provider-private', prompt: 'must disappear', error_message: 'Bearer abcdef https://private/path?token=a', billing_detail: 'provider cost: 0.2' }] }; }
    });
    const response = await request(f.port, '/v1/videos/failed');
    const id = response.headers['x-request-id'];
    assert.deepEqual(lookups, []);
    const target = `/internal/diagnostics?requestId=${id}&includeRelayLog=1`;
    assert.equal((await request(f.port, target)).status, 404);
    assert.deepEqual(lookups, []);
    const admin = await request(f.port, target, { headers: { 'x-corvas-diagnostics-key': SECRET } });
    assert.deepEqual(lookups, [id]);
    assert.equal(admin.json.relayLog.rows[0].cost, 2.3);
    assert.equal(admin.json.relayLog.rows[0].channel_name, 'provider-private');
    assert.equal(admin.json.relayLog.billingState, 'unknown');
    assert.ok(!admin.text.includes('must disappear'));
    assert.ok(!admin.text.includes('abcdef'));
    assert.ok(!admin.text.includes('https://private'));
    assert.equal((await request(f.port, '/internal/diagnostics?requestId=../../secret&includeRelayLog=1', { headers: { 'x-corvas-diagnostics-key': SECRET } })).status, 404);
    assert.equal(lookups.length, 1);
});

test('retention bounds records by both age and count', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-diagnostic-retention-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let now = Date.now();
    const store = createDiagnosticsStore({ directory, maxRecords: 2, ttlMs: 1000, now: () => now });
    const ids = [1, 2, 3].map(value => `rh_${String(value).padStart(32, '0')}`);
    for (const requestId of ids) { now++; store.put({ requestId, error: 'private failure' }); }
    assert.equal(store.get(ids[0]), null);
    assert.ok(store.get(ids[2]));
    assert.equal(fs.readdirSync(directory).length, 2);
    now += 1001;
    assert.equal(store.get(ids[2]), null);
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.throws(() => store.put({ requestId: '../../secret' }), /Invalid/);
    assert.equal(sanitizePrivate({ response_body: '{"prompt":"hidden","error":{"message":"safe"}}' }).response_body.prompt, '[omitted]');
});

test('exact rule files reload and invalid replacements keep the prior mapping', async t => {
    const ruleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-error-rules-'));
    t.after(() => fs.rmSync(ruleDirectory, { recursive: true, force: true }));
    const rulesFile = path.join(ruleDirectory, 'rules.json');
    fs.writeFileSync(rulesFile, JSON.stringify([{ upstreamCode: 'vendor-reference-error', publicCode: 'RH_MEDIA_TOO_LARGE' }]));
    const f = await fixture(t, (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"code":"vendor-reference-error","message":"private vendor error"}}'); }, { rulesFile });
    assert.equal((await request(f.port, '/v1/videos/job')).json.error.code, 'RH_MEDIA_TOO_LARGE');
    fs.writeFileSync(rulesFile, JSON.stringify([{ upstreamCode: 'vendor-reference-error', publicCode: 'RH_MEDIA_UNREADABLE' }]));
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(rulesFile, later, later);
    assert.equal((await request(f.port, '/v1/videos/job')).json.error.code, 'RH_MEDIA_UNREADABLE');
    fs.writeFileSync(rulesFile, 'not JSON');
    assert.equal((await request(f.port, '/v1/videos/job')).json.error.code, 'RH_MEDIA_UNREADABLE');
});

test('optional private log classification exposes constraints but never provider diagnostics', async t => {
    let calls = 0;
    const f = await fixture(t, (req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"code":"RH_INVALID_REQUEST","message":"request failed"}}');
    }, { classifyFromLog: true, logReader: async id => {
        calls++;
        return { state: 'found', rows: [{ log_id: id, cost: 1.06, channel_name: 'private-supplier', original_response_error: { error: { code: 'invalid_duration', message: 'private-supplier duration between 1 and 12; received 15; cost 1.06' } } }] };
    } });
    const response = await request(f.port, '/v1/video/generations', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(calls, 1);
    assert.equal(response.json.error.parameterIssues[0].max, 12);
    assert.equal(response.json.error.billingState, 'unknown');
    assert.ok(!response.text.includes('private-supplier'));
    assert.ok(!response.text.includes('1.06'));
    const diagnostic = await f.admin(response.headers['x-request-id']);
    assert.equal(diagnostic.json.record.relayLogAtFailure.rows[0].cost, 1.06);
});

test('log classification ignores other request IDs and reader failures remain conservative', async t => {
    let call = 0;
    const f = await fixture(t, (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"invalid request"}}'); }, {
        classifyFromLog: true, logReader() {
            if (call++ > 0) throw new Error('database unavailable');
            return { state: 'found', rows: [{ log_id: `rh_${'0'.repeat(32)}`, original_response_error: { error: { message: 'duration between 1 and 12' } } }] };
        }
    });
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request(f.port, '/v1/videos/job');
        assert.equal(response.status, 400);
        assert.equal(response.json.error.parameterIssues.length, 0);
        assert.equal(response.json.error.billingState, 'unknown');
    }
});

test('gateway diagnostics associate legacy log IDs for classification and authenticated lookup', async t => {
    const logId = `fc_${'d'.repeat(32)}`;
    const lookups = [];
    const f = await fixture(t, (req, res) => {
        assert.equal(req.headers['x-log-id'], logId);
        req.resume();
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"invalid request"}}');
    }, { classifyFromLog: true, logReader: async id => {
        lookups.push(id);
        return { state: 'found', rows: [{ log_id: id, original_response_error: { error: { message: 'private provider duration between 1 and 12; received 15' } } }] };
    } });
    const response = await request(f.port, '/v1/video/generations', { method: 'POST', body: '{}',
        headers: { 'content-type': 'application/json', 'x-log-id': logId } });
    const requestId = response.headers['x-request-id'];
    assert.notEqual(requestId, logId);
    assert.equal(response.json.error.request_id, requestId);
    assert.equal(response.json.error.parameterIssues[0].max, 12);
    assert.ok(!response.text.includes(logId));
    assert.ok(!response.text.includes('private provider'));
    assert.equal(response.json.task_id, undefined);
    const admin = await request(f.port, `/internal/diagnostics?requestId=${requestId}&includeRelayLog=1`,
        { headers: { 'x-corvas-diagnostics-key': SECRET } });
    assert.equal(admin.status, 200);
    assert.equal(admin.json.record.requestId, requestId);
    assert.equal(admin.json.record.relayLogId, logId);
    assert.deepEqual(lookups, [logId, logId]);
    const legacyLookup = await f.admin(logId);
    assert.equal(legacyLookup.status, 200);
    assert.equal(legacyLookup.json.record.requestId, requestId);
    assert.equal(legacyLookup.json.records.length, 1);
    assert.equal(legacyLookup.json.gatewayRecordMissing, false);
});

test('legacy correlation matches exact aliases, survives restart and expires with records', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-diagnostic-correlation-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let now = Date.now();
    const options = { directory, maxRecords: 20, ttlMs: 1000, now: () => now };
    let store = createDiagnosticsStore(options);
    const logId = `fc_${'c'.repeat(32)}`;
    const unrelated = `fc_${'d'.repeat(32)}`;
    for (let value = 1; value <= 12; value++) {
        const requestId = `rh_${String(value).padStart(32, '0')}`;
        store.put({ requestId, relayLogId: value % 2 ? logId : unrelated, clientRequestId: logId });
    }
    store = createDiagnosticsStore(options);
    const found = store.find(logId);
    assert.equal(found.matchedCount, 12);
    assert.equal(found.records.length, 10);
    assert.equal(found.truncated, true);
    assert.ok(found.records.every(record => [record.relayLogId, record.clientRequestId].includes(logId)));
    assert.equal(store.find(unrelated).matchedCount, 6);
    assert.equal(store.find(logId.slice(0, -1)).matchedCount, 0);
    assert.equal(store.find(`fc_${'e'.repeat(32)}`).matchedCount, 0);
    now += 1100;
    assert.equal(store.find(logId).matchedCount, 0);
    assert.equal(fs.readdirSync(directory).length, 0);
});

test('private lookup returns exact relay evidence without a gateway record, never other IDs', async t => {
    const clientId = `fc_${'8'.repeat(32)}`;
    const gatewayId = `rh_${'7'.repeat(32)}`;
    const wrongId = `fc_${'9'.repeat(32)}`;
    const calls = [];
    const f = await fixture(t, (_req, res) => res.end('unused'), { logReader: async id => {
        calls.push(id);
        return { state: 'found', rows: [
            { log_id: wrongId, cost: 999, channel_name: 'other-request-only' },
            ...(id === clientId || id === gatewayId ? [{ log_id: id, user_id: 12, token_id: 45, cost: 2.4, refund_status: 'pending',
                api_key: 'never-read', token: 'never-token', response_data: { error: { message: 'provider reason', prompt: 'private-input' } } }] : [])
        ] };
    } });
    for (const id of [clientId, gatewayId]) {
        const target = `/internal/diagnostics?requestId=${id}&includeRelayLog=1`;
        assert.equal((await request(f.port, target)).status, 404);
        assert.equal((await request(f.port, target, { headers: { 'x-corvas-diagnostics-key': 'wrong' } })).status, 404);
        const response = await request(f.port, target, { headers: { 'x-corvas-diagnostics-key': SECRET } });
        assert.equal(response.status, 200);
        assert.equal(response.json.record, null);
        assert.deepEqual(response.json.records, []);
        assert.equal(response.json.gatewayRecordMissing, true);
        assert.equal(response.json.relayLog.state, 'found');
        assert.equal(response.json.relayLog.billingState, 'unknown');
        assert.equal(response.json.relayLog.rows.length, 1);
        assert.equal(response.json.relayLog.rows[0].log_id, id);
        assert.equal(response.json.relayLog.rows[0].token_id, 45);
        assert.equal(response.json.relayLog.rows[0].user_id, 12);
        assert.equal(response.json.relayLog.rows[0].refund_status, 'pending');
        for (const secret of ['other-request-only', 'never-read', 'never-token', 'private-input']) assert.ok(!response.text.includes(secret));
    }
    assert.deepEqual(calls, [clientId, gatewayId]);
    const missing = await request(f.port, `/internal/diagnostics?requestId=fc_${'6'.repeat(32)}&includeRelayLog=1`,
        { headers: { 'x-corvas-diagnostics-key': SECRET } });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.billingState, 'unknown');
    assert.ok(!missing.text.includes('other-request-only'));
    assert.equal((await request(f.port, `/internal/diagnostics?requestId=${clientId}&requestId=${gatewayId}&includeRelayLog=1`,
        { headers: { 'x-corvas-diagnostics-key': SECRET } })).status, 404);
    assert.equal(calls.length, 3);
});

test('one client request can collect several exact gateway attempts with bounded log lookups', async t => {
    const clientId = `fc_${'f'.repeat(32)}`;
    const unrelated = `fc_${'e'.repeat(32)}`;
    const calls = [];
    const f = await fixture(t, (req, res) => {
        req.resume();
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"invalid request"}}');
    }, { logReader: async id => { calls.push(id); return { state: 'found', rows: [{ log_id: id, cost: 1 }] }; } });
    for (let attempt = 0; attempt < 12; attempt++) {
        await request(f.port, '/v1/video/generations', { method: 'POST', body: '{}',
            headers: { 'content-type': 'application/json', 'x-request-id': attempt === 11 ? unrelated : clientId } });
    }
    const response = await request(f.port, `/internal/diagnostics?requestId=${clientId}&includeRelayLog=1`,
        { headers: { 'x-corvas-diagnostics-key': SECRET } });
    assert.equal(response.status, 200);
    assert.equal(response.json.matchedCount, 11);
    assert.equal(response.json.records.length, 10);
    assert.equal(response.json.recordsTruncated, true);
    assert.equal(response.json.relayLogLookupTruncated, true);
    assert.equal(calls.length, 4);
    assert.equal(calls[0], clientId);
    assert.ok(response.json.records.every(record => record.clientRequestId === clientId));
    assert.ok(!response.text.includes(unrelated));
});

test('known request envelopes retain parameters and reference counts, but never their contents', async t => {
    const body = { action: 'textGenerate', platform: '55', model: 'sd2-fast', request: {
        prompt: 'nested private prompt to remove', duration: 12, seconds: '12', resolution: '720p', aspect_ratio: '9:16',
        image_urls: ['https://private/image-a', 'https://private/image-b'], video_urls: ['https://private/video'], audio_urls: [],
        arbitrary: { secret: 'never', duration: 999 }, parameters: { seed: 12, fps: 24, n: 1 }
    } };
    assert.deepEqual(metadataFromBody(body), { action: 'textGenerate', platform: '55', model: 'sd2-fast', resolution: '720p',
        aspect_ratio: '9:16', duration: 12, seconds: 12, seed: 12, fps: 24, n: 1, referenceCounts: { images: 2, videos: 1, audios: 0 } });
    const f = await fixture(t, (req, res) => {
        req.resume();
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Provider A rejected ${body.request.prompt}` } }));
    });
    const failed = await request(f.port, '/v1/video/generations', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const record = await f.admin(failed.headers['x-request-id']);
    assert.equal(record.json.record.request.duration, 12);
    assert.equal(record.json.record.request.referenceCounts.images, 2);
    assert.ok(!record.text.includes('nested private prompt'));
    assert.ok(!record.text.includes('private/image'));
    const minimax = metadataFromBody({ input: { first_image: 'image-a', last_image: 'image-b', reference_video: 'video', reference_audio: 'audio' } });
    assert.deepEqual(minimax.referenceCounts, { images: 2, videos: 1, audios: 1 });
    const ark = metadataFromBody({ content: [{ type: 'text', text: 'private' }, { type: 'image_url', image_url: { url: 'private' } }, { type: 'audio_url' }] });
    assert.deepEqual(ark.referenceCounts, { images: 1, videos: 0, audios: 1 });
});

test('aggregate diagnostic evidence stays under the connector limit and marks omission', async t => {
    const clientId = `fc_${'4'.repeat(32)}`;
    const f = await fixture(t, (_req, res) => res.end('unused'), { logReader: async id => ({ state: 'found', rows: [{ log_id: id, cost: 1 }] }) });
    const store = createDiagnosticsStore({ directory: f.directory });
    for (let i = 1; i <= 10; i++) {
        store.put({ requestId: `rh_${String(i).padStart(32, '0')}`, relayLogId: clientId,
            error: { details: Array.from({ length: 6 }, () => 'diagnostic reason '.repeat(1900)) } });
    }
    // A restarted store rebuilds the same correlation index from private files.
    const restarted = createGateway({ diagnosticsKey: SECRET, recordsDirectory: f.directory,
        logReader: async id => ({ state: 'found', rows: [{ log_id: id, cost: 1 }] }) });
    const port = await listen(restarted);
    t.after(() => close(restarted));
    const response = await request(port, `/internal/diagnostics?requestId=${clientId}&includeRelayLog=1`,
        { headers: { 'x-corvas-diagnostics-key': SECRET } });
    assert.equal(response.status, 200);
    assert.ok(response.bytes.length < 1024 * 1024);
    assert.equal(response.json.matchedCount, 10);
    assert.equal(response.json.evidenceTruncated, true);
    assert.equal(response.json.recordsTruncated, true);
    assert.ok(response.json.records.length < 10);
    assert.equal(response.json.record.requestId, response.json.records[0].requestId);
    assert.equal(response.json.relayLog.billingState, 'unknown');
});
