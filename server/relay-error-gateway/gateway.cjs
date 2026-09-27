/* global __dirname */
const http = require('node:http');
const { Buffer } = require('node:buffer');
const { URL } = require('node:url');
const process = require('node:process');
const console = require('node:console');
const { setTimeout, clearTimeout } = require('node:timers');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { normalizeRelayFailure, failureNode, isTerminalFailure, findExplicitTaskId } = require('../../shared/public-api-error.cjs');
const { CORRELATION_ID, sanitizePrivate, sanitizeText, createDiagnosticsStore } = require('./diagnostics-store.cjs');

const UPSTREAM = 'http://127.0.0.1:8080';
const RELAY_LOG_ID = /^(?:fc|rh)_[a-f0-9]{32}$/;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function cleanHeaders(headers) {
    const blocked = new Set([...HOP_HEADERS, ...String(headers.connection || '').toLowerCase().split(',').map(item => item.trim())]);
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

function validTarget(target) {
    if (typeof target !== 'string' || target.length > 8192 || !target.startsWith('/') || target.startsWith('//')) return null;
    try {
        const pathname = target.split('?')[0];
        const decoded = decodeURIComponent(pathname);
        if (/[\\\x00-\x20#]/.test(decoded) || decoded.includes('//') || decoded.split('/').some(part => part === '.' || part === '..')
            || decoded !== pathname) return null;
        return new URL(target, UPSTREAM);
    } catch { return null; }
}

function mediaPath(pathname) {
    return /^\/v1\/(?:videos?(?:\/|$)|images?(?:\/|$)|tasks?(?:\/|$))/.test(pathname);
}

function metadataFromBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    // These envelopes are known relay protocols, not a recursive body capture.
    const containers = [body, body.request, body.input, body.parameters, body.request?.parameters, body.input?.parameters]
        .filter(value => value && typeof value === 'object' && !Array.isArray(value));
    const result = { referenceCounts: { images: 0, videos: 0, audios: 0 } };
    const fields = ['model', 'resolution', 'aspect_ratio', 'ratio', 'size', 'quality', 'workflow_id', 'action', 'platform'];
    const numericFields = ['duration', 'seconds', 'width', 'height', 'fps', 'n', 'seed'];
    for (const value of containers) {
        for (const field of fields) {
            if (typeof value[field] === 'string' && /^[A-Za-z0-9_.: /()-]{1,160}$/.test(value[field])
                && !/^(?:sk-|oc_live_)/i.test(value[field])) result[field] = value[field];
        }
        for (const field of numericFields) {
            const number = Number(value[field]);
            if (['string', 'number'].includes(typeof value[field]) && value[field] !== ''
                && Number.isFinite(number) && number >= (field === 'seed' ? -1 : 0)
                && number <= (field === 'seed' ? Number.MAX_SAFE_INTEGER : 86400)) result[field] = number;
        }
        for (const [kind, aliases] of Object.entries({ images: ['images', 'image_urls', 'reference_images'],
            videos: ['videos', 'video_urls', 'reference_videos'], audios: ['audios', 'audio_urls', 'reference_audios'] })) {
            result.referenceCounts[kind] = Math.max(result.referenceCounts[kind], ...aliases.map(field => Array.isArray(value[field]) ? value[field].length : 0));
        }
        const present = item => typeof item === 'string' ? item.length > 0 : Boolean(item && typeof item === 'object');
        result.referenceCounts.images = Math.max(result.referenceCounts.images,
            Number(present(value.first_image)) + Number(present(value.last_image)), Number(present(value.image_url)));
        result.referenceCounts.videos = Math.max(result.referenceCounts.videos, Number(present(value.reference_video)), Number(present(value.video_url)));
        result.referenceCounts.audios = Math.max(result.referenceCounts.audios, Number(present(value.reference_audio)), Number(present(value.audio_url)));
        if (Array.isArray(value.content)) {
            for (const [kind, type] of [['images', 'image_url'], ['videos', 'video_url'], ['audios', 'audio_url']]) {
                result.referenceCounts[kind] = Math.max(result.referenceCounts[kind], value.content.filter(item => item?.type === type).length);
            }
        }
    }
    return result;
}

function privatePrompts(body) {
    return [body, body?.request, body?.input, body?.parameters, body?.request?.parameters, body?.input?.parameters]
        .filter(value => value && typeof value === 'object' && !Array.isArray(value))
        .flatMap(value => [value.prompt, value.negative_prompt,
            ...(Array.isArray(value.content) ? value.content.filter(item => item?.type === 'text').map(item => item.text) : [])])
        .filter(value => typeof value === 'string');
}

function exactRelayLog(value, requestId) {
    const rows = value?.state === 'found' && Array.isArray(value.rows)
        ? value.rows.filter(row => row?.log_id === requestId).slice(0, 5) : [];
    if (rows.length) return { state: 'found', billingState: 'unknown', rows: sanitizePrivate(rows) };
    const reason = ['no_matching_log', 'log_reader_unavailable', 'log_reader_invalid_response', 'lookup_timeout', 'not_queried'].includes(value?.reason)
        ? value.reason : 'no_matching_log';
    return { state: 'unknown', reason, billingState: 'unknown', rows: [] };
}

function boundedDiagnostics(records, relayLog) {
    // The CONFIG connector caps responses at 1 MiB; retain complete evidence items.
    let bytes = 0, truncated = false;
    function withinBudget(value) {
        const size = Buffer.byteLength(JSON.stringify(value));
        if (bytes + size > 448 * 1024) { truncated = true; return false; }
        bytes += size;
        return true;
    }
    const selectedRecords = records.filter(withinBudget);
    const rows = relayLog.rows.filter(withinBudget);
    return { records: selectedRecords, relayLog: { ...relayLog, rows }, evidenceTruncated: truncated };
}

function privateErrorFields(payload) {
    if (typeof payload === 'string') return { message: payload };
    if (!payload || typeof payload !== 'object') return null;
    const node = failureNode(payload) || payload;
    return Object.fromEntries(['error', 'Error', 'errors', 'code', 'error_code', 'type', 'error_type', 'status', 'task_status', 'message', 'msg', 'description', 'reason', 'detail', 'details', 'param', 'field',
        'failReason', 'fail_reason', 'failure_reason', 'error_message', 'errorMessage', 'status_msg'].filter(key => Object.hasOwn(node, key)).map(key => [key, node[key]]));
}

function privateResponseIds(payload) {
    const ids = {};
    for (const value of [payload, payload?.data, payload?.result, payload?.error]) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const field of ['request_id', 'requestId', 'trace_id', 'traceId']) {
            if (typeof value[field] === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value[field])) ids[field] = sanitizeText(value[field]);
        }
    }
    return ids;
}

function logFailurePayload(ledger, relayLogId) {
    if (ledger?.state !== 'found' || !Array.isArray(ledger.rows)) return null;
    const row = ledger.rows.find(item => item?.log_id === relayLogId);
    if (!row) return null;
    const original = row.original_response_error || row.response_body || row.response_data;
    let payload = original;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { payload = { error: { message: payload } }; }
    }
    if (payload && failureNode(payload)) return payload;
    if (typeof row.error_message === 'string' && row.error_message.trim()) return { error: { message: row.error_message } };
    return null;
}

function createLogReader({ site, python = 'python3', timeout = 8000 } = {}) {
    if (!['art', 'cart'].includes(site)) return null;
    return relayLogId => new Promise(resolve => {
        if (!RELAY_LOG_ID.test(relayLogId || '')) return resolve({ state: 'unknown', reason: 'invalid_request_id' });
        execFile(python, [path.join(__dirname, 'read-relay-log.py'), '--site', site, '--request-id', relayLogId],
            { timeout, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
                if (error) return resolve({ state: 'unknown', reason: 'log_reader_unavailable' });
                try { resolve(sanitizePrivate(JSON.parse(stdout))); }
                catch { resolve({ state: 'unknown', reason: 'log_reader_invalid_response' }); }
            });
    });
}

function createGateway(options = {}) {
    if (options.upstreamBase && options.upstreamBase !== UPSTREAM) throw new Error('Only the local relay upstream is allowed');
    const secret = options.diagnosticsKey || process.env.CORVAS_DIAGNOSTICS_KEY;
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('CORVAS_DIAGNOSTICS_KEY must contain at least 32 characters');
    const store = options.store || createDiagnosticsStore({ directory: options.recordsDirectory || process.env.RELAY_DIAGNOSTICS_DIR || path.join(__dirname, 'private-records'),
        maxRecords: options.maxRecords, ttlMs: options.ttlMs });
    const upstreamRequest = options.upstreamRequest || http.request;
    const maxRequestBytes = options.maxRequestBytes || 32 * 1024 * 1024;
    const maxResponseBytes = options.maxResponseBytes || 1024 * 1024;
    const configuredImageResponseBytes = options.maxImageResponseBytes ?? process.env.RELAY_GATEWAY_IMAGE_JSON_MAX_BYTES;
    const imageResponseBytes = Number(configuredImageResponseBytes);
    const maxImageResponseBytes = Number.isInteger(imageResponseBytes) && imageResponseBytes > 0
        ? Math.min(imageResponseBytes, 128 * 1024 * 1024) : 64 * 1024 * 1024;
    const timeoutMs = options.timeoutMs || Number(process.env.RELAY_GATEWAY_TIMEOUT_MS) || 3600000;
    const logReader = options.logReader || createLogReader({ site: options.site || process.env.RELAY_SITE });
    const classifyFromLog = options.classifyFromLog === true || process.env.RELAY_ERROR_CLASSIFY_FROM_LOG === '1';
    let pendingLogLookups = 0;
    const rulesFile = options.rulesFile || process.env.RELAY_ERROR_RULES_FILE;
    let cachedRules = [], rulesMtime = -1;
    function rules() {
        if (!rulesFile) return cachedRules;
        try {
            const stat = fs.statSync(rulesFile);
            if (stat.mtimeMs !== rulesMtime && stat.size <= 128 * 1024) {
                const value = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
                if (Array.isArray(value)) { cachedRules = value.slice(0, 500); rulesMtime = stat.mtimeMs; }
            }
        } catch { /* Keep the last valid rule snapshot. */ }
        return cachedRules;
    }
    function authorized(req) {
        const supplied = Buffer.from(String(req.headers['x-corvas-diagnostics-key'] || ''));
        const expected = Buffer.from(secret);
        return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    }
    function json(res, status, body, requestId) {
        if (res.destroyed || res.writableEnded) return;
        const encoded = Buffer.from(JSON.stringify(body));
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': encoded.length,
            'cache-control': 'no-store', ...(requestId ? { 'x-request-id': requestId } : {}) });
        res.end(encoded);
    }
    const server = http.createServer(async (req, res) => {
        const target = validTarget(req.url);
        if (!target) { req.resume(); return json(res, 404, { error: 'not_found' }); }
        if (target.pathname === '/internal/diagnostics') {
            req.resume();
            if (req.method !== 'GET' || !authorized(req)) return json(res, 404, { error: 'not_found' });
            const requestId = target.searchParams.get('requestId');
            if (!CORRELATION_ID.test(requestId || '') || target.searchParams.getAll('requestId').length !== 1) return json(res, 404, { error: 'not_found' });
            try {
                const matches = typeof store.find === 'function' ? store.find(requestId) : { records: [store.get(requestId)].filter(Boolean) };
                const records = (matches.records || []).filter(record => [record.requestId, record.relayLogId, record.clientRequestId].includes(requestId)).slice(0, 10);
                const relayLogIds = [...new Set([...(!records.some(record => record.requestId === requestId) ? [requestId] : []),
                    ...records.map(record => record.relayLogId || record.requestId)].filter(id => RELAY_LOG_ID.test(id || '')))];
                const lookupIds = relayLogIds.slice(0, 4);
                const lookups = await Promise.all(lookupIds.map(async id => {
                    let ledger = { state: 'unknown', reason: 'not_queried' };
                    if (target.searchParams.get('includeRelayLog') === '1' && logReader) {
                        try { ledger = await logReader(id); }
                        catch { ledger = { state: 'unknown', reason: 'log_reader_unavailable' }; }
                    }
                    return { requestId: id, ...exactRelayLog(ledger, id) };
                }));
                const relayLog = { state: lookups.some(item => item.state === 'found') ? 'found' : 'unknown', billingState: 'unknown',
                    rows: lookups.flatMap(item => item.rows), lookups: lookups.map(({ rows: _rows, ...item }) => item) };
                if (!records.length && relayLog.state !== 'found') {
                    const unavailable = lookups.some(item => ['log_reader_unavailable', 'log_reader_invalid_response', 'lookup_timeout'].includes(item.reason));
                    return json(res, unavailable ? 503 : 404, { error: unavailable ? 'diagnostics_unavailable' : 'not_found',
                        gatewayRecordMissing: true, state: 'unknown', billingState: 'unknown' });
                }
                const bounded = boundedDiagnostics(records, relayLog);
                return json(res, 200, { record: bounded.records[0] || null, ...bounded,
                    state: 'found', gatewayRecordMissing: records.length === 0,
                    matchedCount: matches.matchedCount ?? records.length,
                    recordsTruncated: Boolean(matches.truncated || bounded.records.length < records.length),
                    relayLogLookupTruncated: relayLogIds.length > lookupIds.length });
            } catch { return json(res, 503, { error: 'diagnostics_unavailable' }); }
        }
        if (!target.pathname.startsWith('/v1/')) { req.resume(); return json(res, 404, { error: 'not_found' }); }
        const scoped = mediaPath(target.pathname);
        const query = ['GET', 'HEAD'].includes(req.method);
        const requestId = `rh_${crypto.randomBytes(16).toString('hex')}`;
        const clientLogId = req.headers['x-log-id'];
        const relayLogId = typeof clientLogId === 'string' && RELAY_LOG_ID.test(clientLogId) ? clientLogId : requestId;
        const startedTime = Date.now();
        const startedAt = new Date(startedTime).toISOString();
        let metadata = {}, prompts = [], responseIds = {}, handled = false, upstream, bytesSent = 0;
        async function fail(status, payload, extra = {}) {
            if (handled || res.headersSent || res.destroyed) return;
            handled = true;
            let diagnosticLedger = null, classificationPayload = payload;
            if (classifyFromLog && logReader && !extra.transport && extra.stage !== 'validate' && pendingLogLookups < 4) {
                pendingLogLookups++;
                let timer;
                try {
                    const lookup = Promise.resolve().then(() => logReader(relayLogId))
                        .then(value => exactRelayLog(value, relayLogId))
                        .catch(() => ({ state: 'unknown', reason: 'log_reader_unavailable' }))
                        .finally(() => { pendingLogLookups--; });
                    diagnosticLedger = await Promise.race([
                        lookup,
                        new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'unknown', reason: 'lookup_timeout' }), 1500); })
                    ]);
                    classificationPayload = logFailurePayload(diagnosticLedger, relayLogId) || payload;
                } finally { clearTimeout(timer); }
            }
            const result = normalizeRelayFailure(status, classificationPayload, { requestId, query, taskId: findExplicitTaskId(payload), stage: query ? 'poll' : 'submit', rules: rules(), ...extra });
            const clientId = req.headers['x-request-id'] || req.headers['x-log-id'];
            const record = { requestId, relayLogId, createdAt: startedAt, completedAt: new Date().toISOString(),
                elapsedMs: Date.now() - startedTime, method: req.method, path: target.pathname,
                clientRequestId: typeof clientId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(clientId) ? sanitizeText(clientId) : null,
                request: metadata, upstreamStatus: status, upstreamBodyBytesSent: bytesSent,
                responseIds: { ...responseIds, ...privateResponseIds(payload) }, taskId: result.body.task_id || null,
                error: sanitizePrivate(privateErrorFields(payload), prompts), publicError: result.body.error, billingState: 'unknown',
                ...(diagnosticLedger ? { relayLogAtFailure: sanitizePrivate(diagnosticLedger, prompts) } : {}) };
            try { store.put(record); } catch { if (options.onDiagnosticFailure) options.onDiagnosticFailure(requestId); else console.error('Diagnostics write failed:', requestId); }
            json(res, result.status, result.body, requestId);
        }
        function sendToUpstream(body) {
            const headers = cleanHeaders(req.headers);
            delete headers['x-corvas-diagnostics-key'];
            delete headers['x-forwarded-host'];
            headers.host = '127.0.0.1:8080';
            headers['x-log-id'] = relayLogId;
            headers['x-request-id'] = requestId;
            upstream = upstreamRequest(new URL(req.url, UPSTREAM), { method: req.method, headers }, response => {
                const status = response.statusCode || 502;
                responseIds = Object.fromEntries(['x-request-id', 'request-id', 'x-log-id', 'trace-id']
                    .filter(name => typeof response.headers[name] === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(response.headers[name]))
                    .map(name => [name, sanitizeText(response.headers[name])]));
                const normalizedError = scoped && (status < 200 || status >= 300);
                const responseLimit = !normalizedError && /^\/v1\/images(?:\/|$)/.test(target.pathname)
                    ? maxImageResponseBytes : maxResponseBytes;
                const contentType = String(response.headers['content-type'] || '');
                const isJson = /(?:application\/json|\+json)(?:\s*;|$)/i.test(contentType);
                const isMediaStream = /^(?:(?:image|video|audio)\/[^;\s]+|application\/octet-stream|text\/event-stream)(?:\s*;|$)/i.test(contentType);
                if (!normalizedError && (!scoped || isMediaStream || req.method === 'HEAD' || [204, 205].includes(status))) return streamResponse(response);
                const chunks = [];
                let size = 0;
                response.on('data', chunk => {
                    if (handled) return;
                    size += chunk.length;
                    if (size > responseLimit) {
                        // A 2xx JSON envelope can still contain a private task failure.
                        fail(status, { error: { message: 'Relay JSON body exceeds inspection limit' } }, { transport: !normalizedError });
                        chunks.length = 0;
                        response.destroy();
                    } else chunks.push(chunk);
                });
                response.on('end', () => {
                    if (handled) return;
                    const original = Buffer.concat(chunks);
                    let decoded = original, value = null, parsed = false;
                    try {
                        const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
                        if (encoding === 'gzip') decoded = zlib.gunzipSync(original, { maxOutputLength: responseLimit });
                        else if (encoding === 'deflate') decoded = zlib.inflateSync(original, { maxOutputLength: responseLimit });
                        else if (encoding === 'br') decoded = zlib.brotliDecompressSync(original, { maxOutputLength: responseLimit });
                        else if (encoding && encoding !== 'identity') throw new Error('Unknown encoding');
                        value = JSON.parse(decoded.toString('utf8'));
                        parsed = true;
                    } catch { /* Unparseable errors become generic safe errors. */ }
                    if (!normalizedError && !parsed) {
                        fail(status, { error: { message: 'Relay JSON body cannot be safely inspected' } }, { transport: !normalizedError });
                    } else if (normalizedError || (value && failureNode(value))) {
                        fail(status, value || { error: { message: isJson ? 'Invalid JSON error response' : decoded.toString('utf8') } }, { terminal: query && isTerminalFailure(value) });
                    } else {
                        handled = true;
                        res.writeHead(status, { ...cleanHeaders(response.headers), 'x-request-id': requestId });
                        res.end(original);
                    }
                });
                response.on('error', () => fail(502, { error: { message: 'Relay response interrupted' } }, { transport: true }));
                response.on('aborted', () => fail(502, { error: { message: 'Relay response interrupted' } }, { transport: true }));
            });
            upstream.setTimeout(timeoutMs, () => { fail(504, { error: { message: 'Relay request timeout' } }, { transport: true }); upstream.destroy(); });
            upstream.on('error', () => fail(502, { error: { message: 'Relay connection failed' } }, { transport: true }));
            if (body) { bytesSent = body.length; upstream.end(body); }
            else {
                req.on('data', chunk => {
                    bytesSent += chunk.length;
                    if (bytesSent > maxRequestBytes) { req.unpipe(upstream); req.resume(); fail(413, { error: { message: 'Request body exceeded transfer limit' } }, { transport: true }); upstream.destroy(); }
                });
                req.pipe(upstream);
            }
        }
        function streamResponse(response) {
            handled = true;
            res.writeHead(response.statusCode || 502, { ...cleanHeaders(response.headers), 'x-request-id': requestId });
            response.on('error', () => res.destroy());
            response.on('aborted', () => res.destroy());
            response.pipe(res);
        }
        req.on('aborted', () => upstream?.destroy());
        req.on('error', () => upstream?.destroy());
        res.on('close', () => { if (!res.writableEnded) upstream?.destroy(); });
        if (scoped && /application\/json/i.test(String(req.headers['content-type'] || '')) && !query) {
            const chunks = [];
            let size = 0;
            req.on('data', chunk => {
                if (handled) return;
                size += chunk.length;
                if (size > maxRequestBytes) { fail(413, { error: { message: 'Request payload too large' } }, { stage: 'validate', code: 'RH_MEDIA_TOO_LARGE' }); chunks.length = 0; return; }
                chunks.push(chunk);
            });
            req.on('end', () => {
                if (handled) return;
                const body = Buffer.concat(chunks);
                try { const value = JSON.parse(body.toString('utf8')); metadata = metadataFromBody(value); prompts = privatePrompts(value); }
                catch { /* Let the relay validate the original body. */ }
                sendToUpstream(body);
            });
        } else sendToUpstream();
    });
    server.headersTimeout = 15000;
    server.requestTimeout = timeoutMs + 15000;
    return server;
}

if (require.main === module) {
    const server = createGateway();
    server.listen(Number(process.env.RELAY_GATEWAY_PORT || 18089), '127.0.0.1', () => console.log('Relay error gateway listening on loopback'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}

module.exports = { createGateway, createLogReader, metadataFromBody, validTarget, mediaPath, logFailurePayload };
