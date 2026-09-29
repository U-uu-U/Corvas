const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCustomerMessage, prepareCustomerMessage, extractErrorReasons } = require('./customer-error-message.cjs');
const { normalizeRelayFailure, publicErrorResult } = require('./public-api-error.cjs');
const REASON = '远程图片尺寸或宽高比不符合要求（宽高均需在 256～5760 像素，宽高比需在 0.4～2.5）';

test('real MiniMax poll rejection keeps image dimensions, terminal status and actionable classification', () => {
    const value = normalizeRelayFailure(200, { status: 'failed', task_id: 'task-minimax', error: { code: 'task_failed', message: REASON } }, { query: true });
    const result = publicErrorResult(value.body);
    assert.equal(result.code, 'RH_INVALID_REQUEST');
    assert.equal(result.confirmedFailure, true);
    assert.equal(result.taskId, 'task-minimax');
    assert.match(result.customerMessage, /256~5760.*0\.4~2\.5/);
    assert.deepEqual(result.parameterIssues.map(item => item.field), ['referenceImageWidth', 'referenceImageHeight', 'referenceImageAspectRatio']);
    assert.deepEqual(result.parameterIssues.map(({ min, max }) => [min, max]), [[256, 5760], [256, 5760], [0.4, 2.5]]);
    assert.equal(result.action, 'edit_parameters');
});

test('nested error extraction skips prompts, creative content, billing and unrelated properties', () => {
    for (const payload of [{ data: { errors: [{ detail: REASON }] } }, { error: { message: JSON.stringify({ result: { fail_reason: REASON } }) } },
        { base_resp: { status_code: 42, status_msg: REASON } }]) {
        const extracted = extractErrorReasons({ ...payload, prompt: 'private-input', choices: [{ message: { content: 'private-generated-content' } }], billing: { message: 'private-billing' } });
        assert.deepEqual(extracted.map(item => item.text), [REASON]);
    }
    assert.deepEqual(extractErrorReasons({ error: { api_key: 'secret', image_url: 'https://private.test', prompt: 'secret' } }), []);
});

test('urls, bare hosts, credentials, provider aliases and prices do not erase numeric constraints', () => {
    const result = prepareCustomerMessage({ error: { message: `${REASON}。 https://supplier.example/path?key=secret ; supplier.internal ; 10.0.0.1 ; VendorName; api_key=secret-value; Bearer secret-auth; oc_live_secretvalue; 成本 0.8 元； USD 1.06; ￥1.25; 余额不足请充值；` } }, { privateTerms: ['VendorName'] });
    assert.match(result.message, /256~5760.*0\.4~2\.5/);
    assert.doesNotMatch(result.message, /supplier|secret|VendorName|0\.8|1\.06|1\.25|余额|充值|10\.0/);
    assert.ok(result.audit.rules.includes('financial'));
    assert.ok(result.audit.rules.includes('credential'));
    assert.ok(result.audit.rules.includes('url'));
    assert.equal(result.audit.needsReview, false);
});

test('HTTP codes, durations and sizes remain useful; HTML and bodies fail closed', () => {
    assert.match(sanitizeCustomerMessage('HTTP 400: 图片大小不得超过 20 MB，参考视频长度必须在 2 到 15 秒').message, /HTTP 400.*20 MB.*2 到 15/);
    assert.equal(prepareCustomerMessage({ error: { message: '<html><script>private</script></html>' } }).audit.needsReview, true);
    assert.equal(prepareCustomerMessage({ error: { message: '任务失败' } }).message, '');
    assert.equal(sanitizeCustomerMessage('prompt: PRIVATE TEXT; ' + REASON).message.includes('PRIVATE'), false);
});

test('unfamiliar actionable errors remain visible without a model-specific mapping', () => {
    const message = '首帧和尾帧的颜色空间必须一致，请统一为 sRGB 后重试';
    const result = publicErrorResult(normalizeRelayFailure(200, { status: 'failed', error: { message } }, { query: true }).body);
    assert.match(result.customerMessage, /首帧和尾帧的颜色空间必须一致.*请统一为 sRGB 后重试/);
    assert.match(result.error, /颜色空间必须一致/);
});

test('upstream account errors and uncertain submissions cannot inherit customer actions from raw text', () => {
    for (const [status, message, options] of [[402, '余额不足，请充值 2 元', {}], [401, 'API key invalid please replace your key', {}],
        [502, REASON, {}], [504, REASON, { transport: true }]]) {
        const result = publicErrorResult(normalizeRelayFailure(status, { error: { message } }, options).body);
        assert.equal(result.customerMessage, undefined);
        assert.doesNotMatch(result.error, /充值|replace your key|256/);
    }
});
