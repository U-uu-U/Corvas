const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CATALOG, failureNode, publicFailure, readPublicError, publicErrorResult, mapLocalError,
    normalizeRelayFailure, normalizeParameterIssues } = require('./public-api-error.cjs');
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
    [400, 'This model is not supported on the Chat Completions endpoint', 'RH_MODEL_ENDPOINT_MISMATCH'],
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
    assert.equal(Object.keys(result.body).join(','), code === 'RH_CONTENT_REJECTED' ? 'error,status' : 'error');
});

test('POST transport and 5xx retain unknown outcome without resubmission', () => {
    for (const status of [502, 503, 504]) {
        const result = publicFailure(status, { error: privateDetail }, { requestId });
        assert.equal(result.body.error.code, 'RH_SUBMISSION_UNKNOWN');
        assert.equal(result.body.error.submissionUnknown, true);
        assert.equal(result.body.error.retryable, false);
    }
});

test('explicit model routing rejection is unavailable while ambiguous POST failures remain unknown', () => {
    const rejection = { code: 'fail_to_fetch_task', message: JSON.stringify({ error: {
        code: 'model_not_found', type: 'new_api_error',
        message: 'No available channel for model seedance-2.5-pro-720 under group default (distributor)'
    } }), data: null };
    const result = mapLocalError(503, rejection);
    assert.equal(result.code, 'RH_MODEL_UNAVAILABLE');
    assert.equal(result.submissionUnknown, false);
    assert.equal(result.retryable, false);
    assert.equal(mapLocalError(503, rejection, { transport: true }).code, 'RH_SUBMISSION_UNKNOWN');
    assert.equal(mapLocalError(503, { ...rejection, task_id: 'already-created' }).code, 'RH_SUBMISSION_UNKNOWN');
    assert.equal(mapLocalError(503, { error: 'model service temporarily unavailable' }).code, 'RH_SUBMISSION_UNKNOWN');
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

test('gateway preserves explicit routing rejection codes through message extraction without exposing account groups', () => {
    const upstream = { error: { code: 'model_not_found', type: 'new_api_error',
        message: 'No available channel for model sd2-fast under group default (distributor)' } };
    for (const payload of [upstream, { code: 'fail_to_fetch_task', message: JSON.stringify(upstream), data: null }]) {
        const result = normalizeRelayFailure(503, payload, { requestId, origin: 'upstream' });
        assert.equal(result.body.error.code, 'RH_MODEL_UNAVAILABLE');
        assert.equal(result.body.error.submissionState, 'rejected');
        assert.equal(result.body.error.submissionUnknown, false);
        assert.equal(result.body.error.billingState, 'unknown');
        assert.equal(result.body.error.retryable, false);
        assert.doesNotMatch(JSON.stringify(result.body), /distributor|default|sd2-fast/);
        assert.equal(publicErrorResult(result.body).code, 'RH_MODEL_UNAVAILABLE');
    }
    for (const options of [{ transport: true }, { taskId: 'existing-task' }]) {
        assert.equal(normalizeRelayFailure(503, upstream, options).body.error.code, 'RH_SUBMISSION_UNKNOWN');
    }
    assert.equal(normalizeRelayFailure(503, { error: { message: 'No available channel for model sd2-fast' } }).body.error.code,
        'RH_SUBMISSION_UNKNOWN', 'unstructured 503 remains ambiguous');
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

const reviewCases = [
    ['素材图片包含版权内容，审核未通过', 'RH_REFERENCE_COPYRIGHT'],
    ['内容审核未通过，请修改后重试', 'RH_CONTENT_REJECTED'],
    ['提示词审核不通过', 'RH_PROMPT_REJECTED'],
    ['参考视频未通过内容安全检查', 'RH_REFERENCE_REJECTED'],
    ['生成结果未通过内容审核', 'RH_OUTPUT_REJECTED'],
    ['Reference image rejected: copyrighted content', 'RH_REFERENCE_COPYRIGHT'],
    ['Copyright policy violation', 'RH_COPYRIGHT_REJECTED'],
    ['prompt_moderation_failed', 'RH_PROMPT_REJECTED'],
    ['Output video blocked by content filter', 'RH_OUTPUT_REJECTED']
];

for (const [reason, code] of reviewCases) test(`review reason preserves its category: ${code} / ${reason}`, () => {
    const envelopes = [
        { error: { message: reason, supplier: privateDetail } },
        { data: { status: 'failed', failure_reason: reason } },
        { status: 'failed', result: { reason } },
        { success: false, result: { error: { detail: reason } } },
        { base_resp: { status_code: 104, status_msg: reason } }
    ];
    for (const payload of envelopes) {
        for (const status of [200, 400, 403, 500]) {
            const result = mapLocalError(status, payload, { query: true, taskId: 'review-task' });
            assert.equal(result.code, code);
            assert.equal(result.confirmedFailure, true);
            assert.equal(result.retryable, false);
            assert.equal(result.submissionUnknown, false);
            assert.equal(result.taskId, 'review-task');
            assert.doesNotMatch(result.error, /supplier-secret|Bearer|sk-private|服务暂时不可用|未能完成/);
        }
    }
});

test('review service failures, pending review and creative output are not content rejections', () => {
    for (const reason of ['审核服务暂时不可用', '审核接口超时', 'Moderation service failed', 'copyright service unavailable']) {
        const result = mapLocalError(503, { error: { message: reason } }, { query: true });
        assert.equal(result.confirmedFailure, false);
        assert.equal(result.retryable, true);
    }
    for (const payload of [
        { status: 'pending', message: '内容审核中' },
        { status: 'processing', description: 'Copyright review pending' },
        { status: 'completed', prompt: '素材图片包含版权内容，审核未通过', output: { content: '内容审核未通过' } },
        { choices: [{ message: { content: '生成结果未通过内容审核' } }] }
    ]) assert.equal(failureNode(payload), null);
    const unknown = mapLocalError(200, { status: 'failed', reason: privateDetail }, { query: true });
    assert.equal(unknown.code, 'RH_TASK_FAILED');
    assert.equal(unknown.confirmedFailure, true);
    assert.doesNotMatch(unknown.error, /supplier-secret|Bearer/);
    assert.equal(mapLocalError(502, { error: { message: reviewCases[0][0] } }).submissionUnknown, true);
});

test('public review errors cannot lose terminal state or echo a substituted sensitive message', () => {
    for (const [reason, code] of reviewCases) {
        const value = publicFailure(200, { error: reason }, { query: true, taskId: 'review-task' }).body;
        value.error.message = privateDetail;
        value.error.retryable = true;
        for (const result of [publicErrorResult(value), mapLocalError(200, value, { query: true })]) {
            assert.equal(result.code, code);
            assert.equal(result.confirmedFailure, true);
            assert.equal(result.retryable, false);
            assert.equal(result.taskId, 'review-task');
            assert.equal(result.error, CATALOG[code][1]);
        }
    }
});

test('StarFrame metadata failure reasons classify reference duration limits without exposing details', () => {
    for (const reason of [
        'Reference audio duration exceeds maximum 15 seconds: received 71.745 seconds',
        'Input video duration must be between 2 and 15 seconds',
        '参考音频总时长超过 15 秒限制',
        '参考视频时长不足 2 秒'
    ]) {
        const result = mapLocalError(200, { id: 'task-starframe', status: 'failed',
            metadata: { fail_reason: reason + privateDetail } }, { query: true });
        assert.equal(result.code, 'RH_INVALID_REQUEST');
        assert.equal(result.taskId, 'task-starframe');
        assert.equal(result.confirmedFailure, true);
        assert.equal(result.retryable, false);
        assert.doesNotMatch(result.error, /supplier-secret|71\.745|sk-private/);
    }
    const rejected = mapLocalError(200, { data: { id: 'task-starframe', status: 'failed',
        metadata: { fail_reason: 'Reference image rejected: copyrighted content ' + privateDetail } } }, { query: true });
    assert.equal(rejected.code, 'RH_REFERENCE_COPYRIGHT');
    assert.equal(rejected.taskId, 'task-starframe');
    assert.equal(failureNode({ status: 'completed', metadata: { prompt: 'Reference audio duration exceeds limit', content: privateDetail } }), null);
});

test('v2 keeps actionable numeric parameter details while removing all free text and billing claims', () => {
    const payload = normalizeRelayFailure(400, { error: { message: 'duration must be between 1 and 12 seconds; received 15 ' + privateDetail },
        upstreamCost: 0.1, billingState: 'refunded' }, { requestId: 'fc_12345678', stage: 'submit' });
    const result = publicErrorResult(payload.body);
    assert.equal(result.protocolVersion, 2);
    assert.equal(result.category, 'parameter');
    assert.equal(result.submissionState, 'rejected');
    assert.equal(result.billingState, 'unknown');
    assert.equal(result.taskId, null);
    assert.equal(result.requestId, 'fc_12345678');
    assert.match(result.error, /1 到 12 秒，当前为 15 秒/);
    assert.doesNotMatch(JSON.stringify(payload), /supplier-secret|upstreamCost|refunded|private-token/);
    assert.deepEqual(mapLocalError(400, payload.body), { ...result });
});

test('v2 upstream account errors never ask the customer to recharge or change their key', () => {
    for (const [status, text] of [[401, 'invalid_api_key'], [402, 'insufficient_quota'], [403, 'access denied']]) {
        const response = normalizeRelayFailure(status, { error: text + privateDetail });
        const error = readPublicError(response.body);
        assert.equal(error.category, 'service');
        assert.equal(error.action, 'contact_support');
        assert.doesNotMatch(error.message, /额度|认证|API 配置|supplier|private/);
        const accountError = readPublicError(normalizeRelayFailure(status, { error: text }, { origin: 'client_account' }).body);
        assert.equal(accountError.action, 'check_account');
        assert.notEqual(accountError.category, 'service');
    }
});

test('v2 unrecognized codes render safe categories and issues, never server messages', () => {
    const body = { error: { type: 'ravenhash_error', protocolVersion: 2, code: 'RH_FUTURE_DURATION_LIMIT',
        category: 'parameter', stage: 'submit', submissionState: 'rejected', action: 'edit_parameters',
        message: privateDetail, debug: privateDetail, parameterIssues: [
            { field: 'duration', rule: 'range', min: 1, max: 12, actual: 15, resolution: '720p', message: privateDetail },
            { field: 'supplier', reason: 'required', actual: privateDetail }
        ] } };
    const error = readPublicError(body);
    assert.match(error.message, /720p 视频时长应为 1 到 12 秒，当前为 15 秒/);
    assert.equal(error.code, 'RH_FUTURE_DURATION_LIMIT');
    assert.equal(error.parameterIssues.length, 1);
    assert.doesNotMatch(JSON.stringify(error), /supplier|private|debug/);
    body.error.category = privateDetail;
    body.error.parameterIssues = [];
    assert.match(readPublicError(body).message, /排查编号联系管理员/);
});

test('v2 uncertain submissions preserve recovery while trace IDs never become task IDs', () => {
    for (const status of [408, 500, 502, 504]) {
        const body = normalizeRelayFailure(status, { request_id: requestId, id: 'vendor-private-id', error: 'content_policy_violation' },
            { requestId, rules: [{ upstreamCode: 'content_policy_violation', publicCode: 'RH_CONTENT_REJECTED' }] }).body;
        const error = readPublicError(body);
        assert.equal(error.submissionState, 'unknown');
        assert.equal(error.confirmedFailure, false);
        assert.equal(error.taskId, null);
        assert.equal(body.task_id, undefined);
        assert.match(error.message, /不要重复提交/);
    }
    const body = normalizeRelayFailure(502, { task_id: 'known-task', error: privateDetail }, { transport: true }).body;
    assert.equal(readPublicError(body).taskId, 'known-task');
    assert.equal(readPublicError(body).action, 'retry_query');
    const queried = normalizeRelayFailure(200, { task_id: 'known-task', status: 'failed', error: 'Reference image rejected: copyrighted content' }, { query: true }).body;
    assert.equal(readPublicError(queried).code, 'RH_REFERENCE_COPYRIGHT');
    assert.equal(readPublicError(queried).confirmedFailure, true);
    assert.match(readPublicError(queried).message, /版权/);
});

test('v2 private mapping rules select only fixed public codes and never override submission uncertainty', () => {
    const rules = [{ upstreamCode: 'vendor_limit_99', publicCode: 'RH_MEDIA_TOO_LARGE', message: privateDetail }];
    const payload = { error: { code: 'vendor_limit_99', message: privateDetail } };
    assert.equal(readPublicError(normalizeRelayFailure(400, payload, { rules }).body).code, 'RH_MEDIA_TOO_LARGE');
    assert.equal(readPublicError(normalizeRelayFailure(502, payload, { rules, transport: true }).body).code, 'RH_SUBMISSION_UNKNOWN');
    assert.doesNotMatch(JSON.stringify(normalizeRelayFailure(400, payload, { rules })), /vendor_limit_99|supplier|private/);
});

test('v2 a failed query alone does not prove a task was accepted', () => {
    for (const status of [401, 404, 502]) {
        const error = readPublicError(normalizeRelayFailure(status, { error: 'query unavailable' }, { query: true }).body);
        assert.equal(error.submissionState, 'unknown');
        assert.equal(error.confirmedFailure, false);
        assert.equal(error.action, 'retry_query');
        assert.doesNotMatch(error.message, /任务已受理/);
    }
    const known = readPublicError(normalizeRelayFailure(502, { error: 'query unavailable' }, { query: true, taskId: 'known-task' }).body);
    assert.equal(known.submissionState, 'accepted');
});

test('v2 parameter whitelist drops unsafe strings and invalid numeric values', () => {
    const issues = normalizeParameterIssues([
        { field: 'duration', reason: 'range', min: -1, max: Infinity, actual: privateDetail, resolution: privateDetail, debug: privateDetail },
        { field: 'resolution', reason: 'unsupported', allowed: ['480p', '720p', privateDetail] },
        { field: 'aspect_ratio', reason: 'unsupported', allowed: ['9:16', privateDetail] },
        { field: '__proto__', reason: 'required', actual: privateDetail }
    ]);
    assert.deepEqual(issues, [{ field: 'duration', reason: 'range' },
        { field: 'resolution', reason: 'unsupported', allowed: ['480p', '720p'] },
        { field: 'aspect_ratio', reason: 'unsupported', allowed: ['9:16'] }]);
});
