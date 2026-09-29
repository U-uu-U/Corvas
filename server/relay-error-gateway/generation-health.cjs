/* global __dirname */
const { execFile } = require('node:child_process');
const path = require('node:path');
const { normalizeRelayFailure } = require('../../shared/public-api-error.cjs');

const DEFAULT_POLICY = Object.freeze({ windowHours: 24, sampleSize: 10, minimumSamples: 3,
    staleHours: 6, healthyRate: 0.8 });
const SUCCESS = new Set(['completed', 'succeeded', 'success', 'done', 'finished']);
const FAILED = new Set(['failed', 'failure', 'error', 'rejected', 'expired']);
const PENDING = new Set(['queued', 'pending', 'processing', 'running', 'in_progress', 'submitted']);
const EXCLUDED = new Set(['RH_INVALID_REQUEST', 'RH_AUTH_FAILED', 'RH_PERMISSION_DENIED', 'RH_QUOTA_EXHAUSTED',
    'RH_RATE_LIMITED', 'RH_MODEL_ENDPOINT_MISMATCH', 'RH_MEDIA_TOO_LARGE', 'RH_MEDIA_UNREADABLE',
    'RH_CONTENT_REJECTED', 'RH_PROMPT_REJECTED', 'RH_REFERENCE_REJECTED', 'RH_OUTPUT_REJECTED',
    'RH_REFERENCE_COPYRIGHT', 'RH_COPYRIGHT_REJECTED', 'RH_PORTRAIT_SELF_REQUIRED', 'RH_PORTRAIT_RESTRICTED']);

function policyFrom(value = {}) {
    const result = { ...DEFAULT_POLICY };
    for (const [key, min, max] of [['windowHours', 1, 168], ['sampleSize', 3, 50], ['minimumSamples', 1, 50],
        ['staleHours', 1, 168], ['healthyRate', 0.01, 1]]) {
        if (Number.isFinite(value[key]) && value[key] >= min && value[key] <= max
            && (key === 'healthyRate' || Number.isInteger(value[key]))) result[key] = value[key];
    }
    result.minimumSamples = Math.min(result.minimumSamples, result.sampleSize);
    return result;
}

function timestamp(value) {
    if (value === null || value === undefined || value === '') return NaN;
    if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(value)) {
        const number = Number(value);
        return number < 1e12 ? number * 1000 : number;
    }
    return Date.parse(value);
}

function classify(record, now, rules) {
    const started = timestamp(record.createdAt);
    if (!Number.isFinite(started) || started > now) return null;
    const response = record.response || {};
    const states = response.states || [];
    const failed = states.some(state => FAILED.has(state));
    const pending = states.some(state => PENDING.has(state)) && !states.some(state => SUCCESS.has(state));
    const cancelled = states.some(state => ['cancelled', 'canceled'].includes(state));
    let state = 'unknown';
    if (cancelled) state = 'excluded';
    else if (record.statusCode >= 400 || failed || record.error || response.errors?.length) {
        const payload = { error: record.error || response.errors?.[0] || { message: failed ? 'Task failed' : 'Service error' } };
        // This classification is private: preserve account categories instead of the public upstream masking.
        const code = normalizeRelayFailure(record.statusCode, payload, { query: true, terminal: failed, rules, origin: 'client_account' }).body.error.code;
        const unresolved = !failed && (record.statusCode === 408 || record.statusCode === 504
            || ['RH_REQUEST_TIMEOUT', 'RH_TASK_NOT_FOUND', 'RH_SUBMISSION_UNKNOWN'].includes(code));
        state = EXCLUDED.has(code) ? 'excluded' : pending || !record.completed || unresolved ? 'unknown' : 'failure';
    } else if (record.completed && record.statusCode >= 200 && record.statusCode < 300 && record.statusCode !== 202 && !pending
        && (states.some(state => SUCCESS.has(state)) || (record.kind === 'image' && !record.async && response.hasOutput))) state = 'success';
    let completed = timestamp(response.completedAt);
    // Only synchronous image calls may use HTTP latency. Async submission latency is not generation time.
    if (!Number.isFinite(completed) && state === 'success' && record.kind === 'image' && !record.async
        && Number.isFinite(record.latencyMs) && record.latencyMs > 0) completed = started + record.latencyMs;
    const validCompletion = completed >= started && completed <= now && completed - started <= 7 * 86400000;
    return { state, started, at: validCompletion ? completed : started,
        seconds: state === 'success' && validCompletion ? (completed - started) / 1000 : null };
}

function aggregateGenerationHealth(input, { now = Date.now(), policy: rawPolicy, rules = [] } = {}) {
    const policy = policyFrom(rawPolicy);
    const unique = new Map();
    for (const row of input.records || []) {
        if (!row.key || typeof row.model !== 'string' || row.model.length > 200) continue;
        const key = `${row.model}:${row.key}`;
        const previous = unique.get(key);
        if (!previous) unique.set(key, row);
        else {
            const latest = row.sequence > previous.sequence ? row : previous;
            unique.set(key, { ...latest, createdAt: timestamp(row.createdAt) < timestamp(previous.createdAt) ? row.createdAt : previous.createdAt });
        }
    }
    const models = new Map();
    for (const row of unique.values()) {
        const result = classify(row, now, rules);
        if (!result || result.at < now - policy.windowHours * 3600000) continue;
        if (!models.has(row.model)) models.set(row.model, []);
        models.get(row.model).push(result);
    }
    return { checkedAt: new Date(now).toISOString(), truncated: Boolean(input.truncated), policy,
        models: [...models].map(([model, rows]) => {
            rows.sort((a, b) => a.at - b.at);
            const relevant = rows.filter(row => row.state !== 'excluded').slice(-policy.sampleSize);
            const completed = relevant.filter(row => ['success', 'failure'].includes(row.state));
            const successes = completed.filter(row => row.state === 'success');
            const timed = successes.filter(row => row.seconds !== null);
            const last = completed.at(-1)?.at || 0;
            const stale = now - last > policy.staleHours * 3600000;
            const insufficient = completed.length < policy.minimumSamples;
            return { model, state: stale || insufficient ? 'unknown'
                : successes.length / completed.length >= policy.healthyRate ? 'available' : 'degraded',
            reason: !relevant.length ? 'no_data' : stale ? 'stale' : insufficient ? 'insufficient' : 'recent',
            samples: relevant.map(row => row.state), successCount: successes.length,
            sampleDurationsSeconds: relevant.map(row => row.seconds),
            failureCount: completed.length - successes.length, excludedCount: rows.filter(row => row.state === 'excluded').length,
            durationSamples: timed.length, averageSeconds: timed.length ? Math.round(timed.reduce((sum, row) => sum + row.seconds, 0) / timed.length) : null,
            validUntil: new Date(Math.min(now + 180000, last + policy.staleHours * 3600000)).toISOString(),
            lastCompletedAt: last ? new Date(last).toISOString() : null };
        }) };
}

function createGenerationHealthReader({ site, readRecords, getPolicy = () => ({}), getRules = () => [], now = Date.now } = {}) {
    let cache = null, pending = null, attemptedAt = 0;
    const read = readRecords || (() => new Promise((resolve, reject) => {
        if (!['art', 'cart'].includes(site)) return reject(new Error('Unknown site'));
        execFile('python3', [path.join(__dirname, 'read-generation-records.py'), '--site', site],
            { timeout: 16000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
                if (error) return reject(new Error('Generation records unavailable'));
                try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid generation records')); }
            });
    }));
    return { async get() {
        if (pending) return pending;
        if (now() - attemptedAt < 60000) {
            if (cache) return cache;
            throw new Error('Generation records unavailable');
        }
        attemptedAt = now();
        pending = Promise.resolve().then(read).then(input => {
            cache = aggregateGenerationHealth(input, { now: now(), policy: getPolicy(), rules: getRules() });
            return cache;
        }).finally(() => { pending = null; });
        return pending;
    } };
}

module.exports = { aggregateGenerationHealth, createGenerationHealthReader, policyFrom };
