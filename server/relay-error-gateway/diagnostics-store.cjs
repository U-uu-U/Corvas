const fs = require('node:fs');
const { Buffer } = require('node:buffer');
const path = require('node:path');

const REQUEST_ID = /^rh_[a-f0-9]{32}$/;
const CORRELATION_ID = /^(?:fc|rh)_[a-f0-9]{32}$/;
const PRIVATE_KEYS = /authorization|api.?key|secret|password|cookie|token|signature|prompt|messages|image_?urls?|video_?urls?|audio_?urls?|reference|base64|request_body|request_data|payload|content/i;
const SAFE_NUMERIC_KEYS = new Set(['token_id', 'input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens', 'cached_tokens']);

function safeNumericMetadata(key, value) {
    return SAFE_NUMERIC_KEYS.has(key) && ((typeof value === 'number' && Number.isFinite(value) && value >= 0)
        || (typeof value === 'string' && /^\d{1,24}$/.test(value)));
}

function sanitizeText(value, prompts = []) {
    let text = String(value).slice(0, 32768);
    for (const prompt of prompts) {
        if (typeof prompt === 'string' && prompt.length >= 4) text = text.split(prompt).join('[prompt omitted]');
    }
    return text
        .replace(/"(?:prompt|negative_prompt|messages|image_urls?|video_urls?|audio_urls?)"\s*:\s*"(?:\\.|[^"\\])*(?:"|$)/gi, '"private_input":"[omitted]"')
        .replace(/\b(?:prompt|negative_prompt)\s*[=:]\s*[^\r\n]+/gi, '[prompt omitted]')
        .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'}]+/gi, '[credential omitted]')
        .replace(/\b(?:sk-|oc_live_|ghp_|gho_)[A-Za-z0-9_-]+/g, '[credential omitted]')
        .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|signature)\s*[=:]\s*["']?[^\s,;"'}]+/gi, '[credential omitted]')
        .replace(/https?:\/\/[^\s<>"'\\]+/gi, '[url omitted]')
        .replace(/data:[^\s"']+/gi, '[media omitted]')
        .replace(/[A-Za-z0-9+/=]{160,}/g, '[encoded data omitted]');
}

function sanitizePrivate(value, prompts = [], depth = 0) {
    if (depth > 8) return '[depth limit]';
    if (typeof value === 'string') {
        // Some backends persist JSON responses as a string.
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object') return sanitizePrivate(parsed, prompts, depth + 1);
        } catch { /* Plain error text. */ }
        return sanitizeText(value, prompts);
    }
    if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizePrivate(item, prompts, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key,
            PRIVATE_KEYS.test(key) && key !== 'referenceCounts' && !safeNumericMetadata(key, item) ? '[omitted]' : sanitizePrivate(item, prompts, depth + 1)]));
    }
    return value == null || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

function createDiagnosticsStore({ directory, maxRecords = 10000, ttlMs = 7 * 86400000, now = Date.now }) {
    if (!directory) throw new Error('A private diagnostics directory is required');
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || !Number.isFinite(ttlMs) || ttlMs < 1) throw new Error('Invalid retention limits');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Diagnostics directory must not be a symlink');
    fs.chmodSync(directory, 0o700);
    const files = new Map();
    const correlations = new Map();
    const recordCorrelations = new Map();
    const reviewRecords = new Map();
    function forget(requestId) {
        for (const id of recordCorrelations.get(requestId) || []) {
            const matches = correlations.get(id);
            matches?.delete(requestId);
            if (!matches?.size) correlations.delete(id);
        }
        recordCorrelations.delete(requestId);
        files.delete(requestId);
        reviewRecords.delete(requestId);
    }
    function index(record) {
        if (record.customerMessageAudit?.needsReview === true) reviewRecords.set(record.requestId, {
            requestId: record.requestId, createdAt: record.createdAt, code: record.publicError?.code,
            analysisId: record.publicError?.analysisId,
            rules: record.customerMessageAudit.rules
        });
        const ids = new Set([record.requestId, record.relayLogId, record.clientRequestId].filter(id => CORRELATION_ID.test(id || '')));
        for (const id of ids) {
            if (!correlations.has(id)) correlations.set(id, new Set());
            correlations.get(id).add(record.requestId);
        }
        recordCorrelations.set(record.requestId, ids);
    }
    function read(requestId) {
        if (!files.has(requestId)) return null;
        try {
            const filename = path.join(directory, `${requestId}.json`);
            const stat = fs.lstatSync(filename);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null;
            const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
            return record?.requestId === requestId ? record : null;
        } catch (error) {
            if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
            throw error;
        }
    }
    for (const name of fs.readdirSync(directory)) {
        if (!/^rh_[a-f0-9]{32}\.json$/.test(name)) continue;
        const filename = path.join(directory, name);
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        fs.chmodSync(filename, 0o600);
        files.set(name.slice(0, -5), stat.mtimeMs);
    }
    function prune() {
        const sorted = [...files].sort((a, b) => a[1] - b[1]);
        for (const [id, timestamp] of sorted) {
            if (timestamp > now() - ttlMs && files.size <= maxRecords) continue;
            try { fs.unlinkSync(path.join(directory, `${id}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            forget(id);
        }
    }
    prune();
    for (const requestId of files.keys()) {
        const record = read(requestId);
        if (record) index(record);
    }
    return {
        listNeedsReview() {
            prune();
            return [...reviewRecords.values()].sort((a, b) => (files.get(b.requestId) || 0) - (files.get(a.requestId) || 0)).slice(0, 50);
        },
        put(record) {
            if (!REQUEST_ID.test(record.requestId || '')) throw new Error('Invalid request id');
            const filename = path.join(directory, `${record.requestId}.json`);
            const data = JSON.stringify(sanitizePrivate(record));
            if (Buffer.byteLength(data) > 256 * 1024) throw new Error('Diagnostic record too large');
            fs.writeFileSync(filename, data, { mode: 0o600, flag: 'wx' });
            files.set(record.requestId, now());
            index(record);
            prune();
        },
        get(requestId) {
            if (!REQUEST_ID.test(requestId || '')) return null;
            prune();
            return read(requestId);
        },
        find(requestId, { limit = 10 } = {}) {
            if (!CORRELATION_ID.test(requestId || '')) return { records: [], matchedCount: 0, truncated: false };
            prune();
            const maximum = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 10)) : 10;
            const matches = [...(correlations.get(requestId) || [])].sort((a, b) =>
                a === requestId ? -1 : b === requestId ? 1 : files.get(b) - files.get(a));
            const records = [];
            for (const id of matches) {
                if (records.length >= maximum) break;
                const record = read(id);
                if (record && [record.requestId, record.relayLogId, record.clientRequestId].includes(requestId)) records.push(record);
            }
            return { records, matchedCount: matches.length, truncated: matches.length > maximum };
        }
    };
}

module.exports = { REQUEST_ID, CORRELATION_ID, sanitizePrivate, sanitizeText, createDiagnosticsStore };
