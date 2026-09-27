const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeErrorSubmission, sanitizeErrorReport, classifyErrorReportSite } = require('./error-report-contract.cjs');
const base = () => ({ formatVersion: 1, submissionId: '12345678-abcd-4abc-8abc-123456789abc', site: 'art',
    description: 'Video failed', context: {}, diagnostic: { events: [], tasks: [], environment: { app: '1.6.0' } } });

test('error reports retain diagnostic evidence while excluding secrets, prompts and binary inputs', () => {
    const value = sanitizeErrorReport({ model: 'sd2-fast', status: 400, token_id: 42, user_id: 12,
        requestId: 'rh_1234567890', params: { duration: 15, resolution: '720p' },
        error: { message: 'duration must be <= 12; Bearer abcde; sk-abcde', stack: 'Error\n at module.js:20' },
        api_key: 'abcde', prompt: 'private story', image_urls: ['https://media.test/private'],
        response: '{"error":{"code":"LIMIT","message":"bad duration"},"apiKey":"hidden"}',
        referenceManifest: [{ sha256: 'a'.repeat(64), bytes: 128, mimeType: 'image/png' }] });
    assert.equal(value.params.duration, 15);
    assert.equal(value.token_id, 42);
    assert.equal(value.error.stack, 'Error\n at module.js:20');
    assert.equal(value.response.error.code, 'LIMIT');
    assert.equal(value.referenceManifest[0].sha256.length, 64);
    assert.doesNotMatch(JSON.stringify(value), /abcde|private story|media\.test|hidden/);
    assert.equal(sanitizeErrorReport('my account opaque-key', ['opaque-key']), 'my account [credential omitted]');
});

test('submission only accepts customer fields and reports truncation explicitly', () => {
    const input = base();
    input.serverEvidence = { cost: 999 };
    input.status = 'resolved';
    input.diagnostic.events = Array.from({ length: 1502 }, (_, n) => ({ sequence: n }));
    const normalized = normalizeErrorSubmission(input);
    assert.equal(normalized.serverEvidence, undefined);
    assert.equal(normalized.status, undefined);
    assert.equal(normalized.diagnostic.events[0].sequence, 2);
    assert.equal(normalized.diagnostic.completeness.eventsSupplied, 1502);
    assert.equal(normalized.diagnostic.completeness.eventsIncluded, 1500);
    assert.throws(() => normalizeErrorSubmission({ ...input, submissionId: '../outside' }), { code: 'INVALID_ERROR_REPORT' });
    assert.throws(() => normalizeErrorSubmission({ ...base(), requestId: 'invalid/../id' }), { code: 'INVALID_ERROR_REPORT' });
    const legacy = normalizeErrorSubmission({ ...base(), requestId: '12345678-abcd-4abc-8abc-123456789abc' });
    assert.equal(legacy.requestId, '');
    assert.equal(legacy.context.requestId, '12345678-abcd-4abc-8abc-123456789abc');
});

test('prefixed, nested and truncated JSON error text cannot carry private credentials or conversations', () => {
    const snippet = JSON.stringify({ api_key: 'supplier-plain-secret', messages: [{ content: 'private prompt' }],
        error: { code: 'INVALID_DURATION', max: 12 } });
    const sanitized = sanitizeErrorReport(`upstream reply: ${snippet} (HTTP 400)`);
    assert.doesNotMatch(sanitized, /supplier-plain-secret|private prompt/);
    assert.match(sanitized, /INVALID_DURATION/);
    assert.match(sanitized, /12/);
    assert.doesNotMatch(sanitizeErrorReport(`upstream reply: ${snippet.slice(0, -2)}`), /supplier-plain-secret|private prompt/);
    assert.doesNotMatch(sanitizeErrorReport(`first ${snippet}\nsecond ${snippet}`), /supplier-plain-secret|private prompt/);
    assert.doesNotMatch(JSON.stringify(sanitizeErrorReport({ error: JSON.stringify({ detail: `upstream reply: ${snippet}` }) })),
        /supplier-plain-secret|private prompt/);
});

test('URL credentials and query strings are excluded, and only known relay hosts identify the site', () => {
    assert.equal(sanitizeErrorReport('https://name:password@art.ravenhash.org/v1/videos?token=hidden'),
        'https://art.ravenhash.org/[path omitted]');
    assert.equal(classifyErrorReportSite('https://cart.ravenhash.org/v1'), 'cart');
    assert.equal(classifyErrorReportSite('https://art.ravenhash.org/v1'), 'art');
    assert.equal(classifyErrorReportSite('https://art.ravenhash.org.attacker.test/v1'), 'unknown');
    const shared = { message: 'readable error' };
    assert.deepEqual(sanitizeErrorReport({ first: shared, second: shared }), { first: shared, second: shared });
});
