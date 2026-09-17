const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeServiceRole, redactSensitiveText, traceSuffix,
    GENERIC_SERVICE_LABEL } = require('./error-redaction.cjs');
const { CATALOG, mapLocalError, publicFailure } = require('./public-api-error.cjs');
const { imageHttpErrorMessage, imageTaskErrorMessage } = require('../electron-main/openai-image-request');
const { getVideoPayloadError } = require('../electron-main/video-provider-adapters');

// 这些串代表「绝不能出现在用户可见文案里」的四类信息：
// 上游地址与主机、凭据、部署拓扑（中转架构 / 渠道 / 账号池）、机器可读负载。
const FORBIDDEN = [
    'https://', 'http://', 'wss://',
    'ai.ravenhash.org', 'art.ravenhash.org', 'video.zhubo.asia', 'vendor-secret.internal',
    '10.0.0.7', '127.0.0.1:8087',
    'sk-livesecret0123456789', 'Bearer abc.def-ghi',
    'NewAPI', 'mj-api-secret', 'yamlrunner_error', 'all_vendors_failed',
    'unmarshal_response_body_failed', '账号池', '渠道映射',
    'minimax-h3 -> MiniMax-H3-c1', 'gpt-image-2-upstream'
];

function assertClean(message, label) {
    const text = String(message ?? '');
    for (const leak of FORBIDDEN) {
        assert.equal(text.includes(leak), false, `${label} 泄漏了 ${leak}：${text}`);
    }
    // JSON 负载特征：带引号的键。上游原文最典型的形态。
    assert.doesNotMatch(text, /\{\s*"/, `${label} 回显了 JSON 原文：${text}`);
    assert.doesNotMatch(text, /"[a-z_]+"\s*:/i, `${label} 回显了 JSON 字段：${text}`);
}

// 各种真实上游失败形态。每一条都同时塞入地址、凭据、渠道名和 JSON 结构。
const UPSTREAM_PAYLOADS = [
    { error: { message: 'channel gpt-image-2-upstream at https://vendor-secret.internal/v1 exhausted',
        type: 'yamlrunner_error', code: 'all_vendors_failed' } },
    { status: 'failed', failReason: 'upstream https://art.ravenhash.org/v1/videos/task_9 returned 500',
        debug: 'apiKey=sk-livesecret0123456789' },
    { code: 5, description: 'unmarshal_response_body_failed', type: 'upstream_error',
        hint: 'NewAPI needs mj-api-secret, use Authorization: Bearer abc.def-ghi' },
    { base_resp: { status_code: 1008, status_msg: '模型不可用，渠道映射 minimax-h3 -> MiniMax-H3-c1 缺失' } },
    { data: { status: 'error', error_message: 'relay 10.0.0.7 refused; see http://127.0.0.1:8087/admin' } },
    { success: false, msg: '账号池已耗尽', vendor: 'vendor-secret.internal' }
];

test('图片与视频的用户可见文案不回显上游地址、凭据、渠道与原文', () => {
    for (const payload of UPSTREAM_PAYLOADS) {
        const text = JSON.stringify(payload);
        assertClean(imageTaskErrorMessage(payload), 'imageTaskErrorMessage');
        assertClean(getVideoPayloadError(payload), 'getVideoPayloadError');
        for (const status of [200, 400, 401, 402, 429, 500, 503]) {
            assertClean(imageHttpErrorMessage(status, text), `imageHttpErrorMessage(${status})`);
            assertClean(mapLocalError(status, text, { query: true }).error, `mapLocalError(${status})`);
            assertClean(mapLocalError(status, payload, { query: false }).error, `mapLocalError(obj,${status})`);
        }
    }
});

test('所有用户可见文案都来自 CATALOG，不是上游文本', () => {
    const catalogMessages = new Set(Object.values(CATALOG).map(([, message]) => message));
    for (const payload of UPSTREAM_PAYLOADS) {
        const mapped = mapLocalError(503, payload, { query: true });
        const base = mapped.error.replace(/（HTTP \d+）/, '').split('\n')[0];
        assert.equal(catalogMessages.has(base), true, `文案不在 CATALOG 中：${base}`);
    }
});

test('publicFailure 只输出目录文案与安全的排查编号', () => {
    const requestId = `rh_${'c'.repeat(32)}`;
    const result = publicFailure(502, UPSTREAM_PAYLOADS[0], { requestId });
    assertClean(result.body.error.message, 'publicFailure');
    assert.equal(result.body.error.request_id, requestId);
    // 上游若自带伪造的 request_id，不得被采纳。
    assert.equal(publicFailure(502, { error: 'x', request_id: 'sk-livesecret0123456789' }).body.error.request_id,
        undefined);
});

test('redactSensitiveText 清洗地址、主机、凭据与负载，并保留可读结论', () => {
    const dirty = '连接 https://art.ravenhash.org/v1/videos?token=secret 失败；'
        + 'relay 10.0.0.7 使用 Authorization: Bearer abc.def-ghi 与 sk-livesecret0123456789；'
        + '响应 {"code":"all_vendors_failed","vendor":"vendor-secret.internal"}；来自 NewAPI 账号池';
    const clean = redactSensitiveText(dirty, { role: 'video' });
    assertClean(clean, 'redactSensitiveText');
    assert.match(clean, /视频生成服务/);
    assert.match(clean, /失败/);
});

test('脱敏不会误伤模型名与版本号', () => {
    // 这些含点的标识不是主机名，必须原样保留，否则模型栏和错误定位都会失真。
    for (const keep of ['sd2.5', 'seedance_v2.5-301010', 'gpt-image-2', 'v1.6.0-beta.3', 'MiniMax-H3-c1']) {
        assert.match(redactSensitiveText(`模型 ${keep} 暂不可用`), new RegExp(keep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
});

test('服务类别标签固定，未知角色回落到通用标签', () => {
    assert.equal(describeServiceRole('image'), '图片生成服务');
    assert.equal(describeServiceRole('video'), '视频生成服务');
    assert.equal(describeServiceRole('download'), '生成产物服务');
    for (const unknown of ['', null, undefined, 'nope', 'ravenhash']) {
        assert.equal(describeServiceRole(unknown), GENERIC_SERVICE_LABEL);
    }
});

test('排查编号只接受安全字符，拒绝凭据形态', () => {
    assert.equal(traceSuffix(`rh_${'a'.repeat(32)}`), `\n排查编号：rh_${'a'.repeat(32)}`);
    assert.equal(traceSuffix('', 'task_9151'), '\n排查编号：task_9151');
    assert.equal(traceSuffix(''), '');
    assert.equal(traceSuffix('has space'), '');
    assert.equal(traceSuffix('https://vendor-secret.internal/x'), '');
});
