const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CATALOG, failureNode, publicFailure, readPublicError, publicErrorResult, mapLocalError } = require('./public-api-error.cjs');
const requestId = 'rh_' + 'a'.repeat(32);
const privateDetail = 'supplier-secret.internal 10.0.0.3 user@example.test /opt/vendor/key.pem sk-private_fake_key Authorization: Bearer private-token';

const portraitReason = 'For 肖像保护, Dreamina Seedance 2.5 只支持生成包含您自己的视频. 请换一张参考图, or create a video from text。';

test('portrait rejection uses the actionable safe message in raw and nested failure envelopes', () => {
    for (const payload of [
        { error: { message: portraitReason + privateDetail } },
        { status: 'failed', data: { error: { message: portraitReason } } },
        ...['failReason', 'fail_reason', 'failure_reason', 'error_message', 'errorMessage'].map(key => ({ data: { [key]: portraitReason } }))
    ]) {
        const result = mapLocalError(200, payload, { query: true, taskId: 'portrait-task' });
        assert.equal(result.code, 'RH_PORTRAIT_SELF_REQUIRED');
        assert.match(result.error, /本人肖像/);
        assert.match(result.error, /更换.*参考图.*纯文字生成/);
        assert.doesNotMatch(result.error, /Dreamina|Seedance|supplier-secret|sk-private|服务暂时/);
        assert.equal(result.confirmedFailure, true);
        assert.equal(result.submissionUnknown, false);
        assert.equal(result.retryable, false);
        assert.equal(result.taskId, 'portrait-task');
    }
});

test('generic likeness restrictions do not invent a self-only rule; missing IDs remain definite rejections', () => {
    const result = mapLocalError(400, { error: { message: 'Realistic human faces are not supported by portrait protection' } });
    assert.equal(result.code, 'RH_PORTRAIT_RESTRICTED');
    assert.equal(result.confirmedFailure, true);
    assert.doesNotMatch(result.error, /仅支持.*本人/);
    const own = mapLocalError(400, { error: 'Only supports videos of yourself' });
    assert.equal(own.code, 'RH_PORTRAIT_SELF_REQUIRED');
    assert.notEqual(mapLocalError(400, { error: 'Only supports videos of your product' }).code, own.code);
    assert.equal(failureNode({ choices: [{ message: { content: portraitReason } }], prompt: portraitReason }), null);
});

test('public portrait failures retain task identity and terminal state through repeated mapping', () => {
    const payload = publicFailure(200, { task_id: 'portrait-task', status: 'failed', error: portraitReason }).body;
    payload.error.message = privateDetail;
    payload.error.retryable = true;
    for (const result of [mapLocalError(200, payload, { query: true }), publicErrorResult(payload)]) {
        assert.equal(result.code, 'RH_PORTRAIT_SELF_REQUIRED');
        assert.equal(result.confirmedFailure, true);
        assert.equal(result.retryable, false);
        assert.equal(result.taskId, 'portrait-task');
        assert.doesNotMatch(result.error, /private|supplier/);
    }
    assert.equal(mapLocalError(502, { error: portraitReason }, { transport: true }).submissionUnknown, true);
    const transient = mapLocalError(503, { status: 'error', error: 'service temporarily unavailable' }, { query: true });
    assert.equal(transient.confirmedFailure, false);
    assert.equal(transient.retryable, true);
});

for (const [status, raw, code] of [
    [400, 'invalid_parameter duration', 'RH_INVALID_REQUEST'],
    [401, 'invalid key', 'RH_AUTH_FAILED'], [402, 'insufficient_quota', 'RH_QUOTA_EXHAUSTED'],
    [403, 'access denied', 'RH_PERMISSION_DENIED'], [413, 'too large', 'RH_MEDIA_TOO_LARGE'],
    [429, 'too many requests', 'RH_RATE_LIMITED'], [400, 'content_policy_violation', 'RH_CONTENT_REJECTED'],
    [400, 'tools are not supported', 'RH_TOOLS_UNSUPPORTED'], [400, 'invalid_image', 'RH_MEDIA_UNREADABLE'],
    [404, 'task gone', 'RH_TASK_NOT_FOUND'], [503, 'no available channel', 'RH_MODEL_UNAVAILABLE'],
    [504, 'timeout', 'RH_REQUEST_TIMEOUT']
]) test(`public error mapping: ${code}`, () => {
    const result = publicFailure(status, { error: { message: raw + privateDetail, supplier: privateDetail }, debug: privateDetail }, { query: true, requestId });
    assert.equal(result.body.error.code, code);
    assert.equal(result.body.error.message, CATALOG[code][1]);
    assert.equal(result.body.error.request_id, requestId);
    assert.equal(JSON.stringify(result).includes('supplier-secret'), false);
    assert.equal(Object.keys(result.body).join(','), 'error');
});

test('POST transport and 5xx retain unknown outcome without resubmission', () => {
    for (const status of [502, 503, 504]) {
        const result = publicFailure(status, { error: privateDetail }, { requestId });
        assert.equal(result.body.error.code, 'RH_SUBMISSION_UNKNOWN');
        assert.equal(result.body.error.submissionUnknown, true);
        assert.equal(result.body.error.retryable, false);
    }
});

test('terminal task failure retains identity but not arbitrary payload fields', () => {
    const result = publicFailure(200, { data: { id: 'job-123', status: 'failed', error: { message: privateDetail } }, debug: privateDetail },
        { requestId, terminal: true, query: true });
    assert.equal(result.status, 200);
    assert.equal(result.body.id, 'job-123');
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.error.code, 'RH_TASK_FAILED');
    assert.equal(result.body.error.retryable, false);
    assert.equal(JSON.stringify(result).includes(privateDetail), false);
});

test('does not treat creative content or completed results as error fields', () => {
    for (const value of [{ choices: [{ message: { content: 'error: authentication failed' } }] },
        { status: 'completed', data: [{ url: 'https://media.test/result.png' }] },
        { data: { status: 'done', code: 10000, error: null } }, { success: true, error: null }]) {
        assert.equal(failureNode(value), null);
    }
    for (const value of [{ data: { error: { message: privateDetail } } },
        { base_resp: { status_code: 1234, status_msg: privateDetail } },
        { code: 24, description: privateDetail }, { type: 'response.failed', response: { error: privateDetail } }]) assert.ok(failureNode(value));
});

test('HTML, nested secrets and malicious trace IDs never enter public errors', () => {
    for (const raw of [`<html>${privateDetail}</html>`, { error: privateDetail, stack: privateDetail, id: 'private-token' }]) {
        const result = publicFailure(500, raw, { requestId: privateDetail });
        assert.deepEqual(Object.keys(result.body), ['error']);
        assert.equal(result.body.error.request_id, undefined);
        assert.equal(JSON.stringify(result).includes('private'), false);
    }
});

test('client validates catalogue and reconstructs rather than displays echoed message', () => {
    const value = publicFailure(502, {}, { requestId }).body;
    value.error.message = privateDetail;
    assert.equal(readPublicError(value).message.includes(privateDetail), false);
    assert.equal(publicErrorResult(value).submissionUnknown, true);
    value.error.code = '__proto__';
    assert.equal(readPublicError(value), null);
    assert.equal(publicErrorResult('not-json'), null);
});
