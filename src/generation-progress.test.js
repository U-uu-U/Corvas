import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGenerationElapsed, isGenerationRecoveryActive, canRecoverGenerationTask, generationFailureError,
    formatClientGenerationError, generationProgressParams, generationTransferLabel,
    formatGenerationDownloadProgress } from './generation-progress.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { imageRequestFailure } = require('../electron-main/image-request-diagnostics.cjs');
const { normalizeRelayFailure, publicErrorResult } = require('../shared/public-api-error.cjs');

test('backend completion stops generation time even while waiting for a URL or refreshing it', () => {
    const task = { status: 'running', params: {} };
    task.params = generationProgressParams(task, { stage: 'processing', progress: 100 }, 1000);
    assert.equal(generationTransferLabel(task), '', '100% alone does not prove completion');
    task.params = generationProgressParams(task, { stage: 'download', remoteStatus: 'completed' }, 2000);
    assert.equal(generationTransferLabel(task), '正在下载...');
    assert.equal(task.params.remoteCompletedAt, 2000);
    task.params = generationProgressParams(task, { stage: 'recovering', lastError: 'temporary failure' }, 6000);
    assert.equal(generationTransferLabel(task), '正在下载...');
    assert.equal(task.params.remoteCompletedAt, 2000);
    task.params = generationProgressParams(task, { stage: 'completed' }, 8000);
    assert.equal(generationTransferLabel(task), '正在保存...');
    task.status = 'failed';
    assert.equal(generationTransferLabel(task), '');
});

test('legacy download aliases and byte progress have one customer-visible presentation', () => {
    for (const stage of ['ready', 'download', 'downloading']) {
        const task = { status: 'running', params: { syncStage: stage } };
        assert.equal(generationTransferLabel(task), '正在下载...');
        task.params = generationProgressParams(task, { stage, downloadedBytes: 1048576, totalBytes: 2097152, bytesPerSecond: 1048576 });
        assert.equal(formatGenerationDownloadProgress(task), '1.0 / 2.0 MB | 1.0 MB/s');
        task.params = generationProgressParams(task, { stage, totalBytes: null, bytesPerSecond: -1 });
        assert.equal(formatGenerationDownloadProgress(task), '1.0 MB');
    }
});

test('customer detail survives gateway, desktop result, Error, renderer and repeated string formatting', () => {
    const payload = normalizeRelayFailure(200, { status: 'failed', task_id: 'minimax-fixture', error: {
        message: '远程图片尺寸或宽高比不符合要求（宽高均需在 256～5760 像素，宽高比需在 0.4～2.5）。https://private.example/file; 成本 $0.8'
    } }, { query: true, requestId: 'rh_' + 'b'.repeat(32) }).body;
    const result = publicErrorResult(payload);
    const failure = generationFailureError(result);
    for (const value of [result, failure, failure.message, formatClientGenerationError(failure.message)]) {
        const message = formatClientGenerationError(value);
        assert.match(message, /256~5760.*0\.4~2\.5/);
        assert.match(message, /原任务已失败/);
        assert.doesNotMatch(message, /private\.example|0\.8|成本/);
    }
    assert.equal(failure.customerMessage, result.customerMessage);
});
const { SD2_FAST_DURATION_CODE, SD2_FAST_DURATION_MESSAGE, createSd2FastDurationError,
    getSd2FastDurationConstraint } = require('../shared/sd2-fast-validation.cjs');

test('SD2 Fast duration rules match only known hosts and resolutions', () => {
    for (const host of ['art.ravenhash.org', 'cart.ravenhash.org', 'yueqi.icu']) {
        const provider = { model: 'sd2-fast', endpoint: `https://${host}/v1` };
        assert.deepEqual(getSd2FastDurationConstraint(provider, '720p'), { min: 1, max: 12, resolution: '720p' });
        assert.deepEqual(getSd2FastDurationConstraint(provider, '480p'), { min: 1, max: 15, resolution: '480p' });
        assert.deepEqual(getSd2FastDurationConstraint(provider), { min: 1, max: 12, resolution: '720p' });
        assert.equal(getSd2FastDurationConstraint(provider, '1080p'), null);
    }
    for (const provider of [undefined, { model: 'sd2-fast', endpoint: 'invalid' },
        { model: 'sd2-fast-other', endpoint: 'https://art.ravenhash.org/v1' },
        { model: 'sd2-fast', endpoint: 'https://art.ravenhash.org.other.test/v1' }]) {
        assert.equal(getSd2FastDurationConstraint(provider, '720p'), null);
    }
});

test('SD2 Fast duration errors retain fixed parameter guidance through repeated display formatting', () => {
    const source = createSd2FastDurationError();
    const error = generationFailureError({ error: source.message, code: source.code, retryable: source.retryable });
    assert.equal(error.code, SD2_FAST_DURATION_CODE);
    assert.equal(error.retryable, false);
    for (const value of [error, error.message, `请求失败：${error.message}`, { code: source.code }]) {
        const message = formatClientGenerationError(value);
        assert.equal(message, SD2_FAST_DURATION_MESSAGE);
        assert.match(message, /720p 支持 1 到 12 秒/);
        assert.match(message, /480p 支持 1 到 15 秒/);
        assert.doesNotMatch(message, /稍后重试/);
    }
});

test('local duration codes rebuild fixed messages without echoing upstream details', () => {
    const dirty = 'vendor=private-provider channel=private-991 https://upstream.test/private?token=secret';
    assert.equal(formatClientGenerationError({ code: SD2_FAST_DURATION_CODE, error: dirty,
        details: { resolution: dirty, max: dirty } }), SD2_FAST_DURATION_MESSAGE);
    assert.equal(formatClientGenerationError(`${SD2_FAST_DURATION_MESSAGE} ${dirty}`), SD2_FAST_DURATION_MESSAGE);
    for (const value of [dirty, { code: 'LOCAL_OTHER_DURATION', error: dirty }]) {
        const message = formatClientGenerationError(value);
        assert.doesNotMatch(message, /vendor|private|secret|upstream/);
        assert.doesNotMatch(message, /720p 支持/);
    }
});

test('uncertain submission keeps no-resubmit guidance and correlation through repeated display formatting', () => {
    const source = imageRequestFailure(new Error('net::ERR_EMPTY_RESPONSE'), {
        requestId: 'client-fixture-42', startedAt: 1000, now: 2000, payloadBytes: 1024, imageCount: 1, phase: 'submit'
    });
    const error = generationFailureError({ error: source.message, ...source });
    for (const message of [error.message, formatClientGenerationError(error.message), formatClientGenerationError(`生图失败：${error.message}`)]) {
        assert.match(message, /不要重复提交/);
        assert.match(message, /client-fixture-42/);
        assert.doesNotMatch(message, /网络请求失败，请稍后重试/);
    }
    assert.equal(error.submissionUnknown, true);
});

test('local model limits and paused-channel guidance survive while forged trusted prefixes do not', () => {
    for (const message of ['Seedance 2.5 Pro 仅支持 480p 或 720p',
        '模型 seedance_v2.5-101010 已暂时停用，请选择其他渠道；已有任务仍可恢复。']) {
        assert.equal(formatClientGenerationError(message), message);
    }
    const dirty = 'GlobalAiOpc 素材审核未通过：vendor=private-provider; channel=private-991; token=upstream-secret';
    const message = formatClientGenerationError(dirty);
    assert.doesNotMatch(message, /GlobalAiOpc|private|upstream-secret|channel|vendor/);
    assert.equal(formatClientGenerationError(''), '');
    assert.equal(formatClientGenerationError({ code: 'RH_AUTH_FAILED', error: dirty }),
        '接口认证失败，请检查 API 配置或联系管理员。');
});

test('客户端错误展示会隐藏上游站点并保留任务标识', () => {
    const message = formatClientGenerationError('下载生成产物失败（https://video.zhubo.asia/v1/videos/task_9151，已尝试 1 次）：HTTP 401');
    assert.equal(message, '下载地址已失效或无访问权限，可在任务记录中继续拉取，无需重新生成（任务 task_9151）');
    assert.equal(message.includes('video.zhubo.asia'), false);
});

// 白名单兜底：无法确认来源的文案不得原样展示。这里直接喂上游原文形态的负载，
// 断言域名、渠道标识和 JSON 原文都不出现，只保留任务 ID 供用户反馈。
test('客户端不展示无法确认来源的上游原文', () => {
    const message = formatClientGenerationError(
        'Image API failed: 503 {"error":{"message":"channel gpt-image-2-upstream exhausted",'
        + '"type":"yamlrunner_error","code":"all_vendors_failed"},"vendor":"vendor-a.example.com"}'
    );
    for (const leak of ['vendor-a.example.com', 'yamlrunner_error', 'all_vendors_failed',
        'channel', 'gpt-image-2-upstream', 'Image API failed', '{"']) {
        assert.equal(message.includes(leak), false, `不应泄漏 ${leak}`);
    }
    assert.match(message, /请求未能完成|服务暂时不可用/);
});

test('CATALOG 文案与本地判定仍可原样展示', () => {
    for (const trusted of ['提示词审核未通过，请修改提示词后重新提交。',
        '可用额度不足，请检查账户额度或联系管理员。',
        '素材文件不存在']) {
        assert.equal(formatClientGenerationError(trusted), trusted);
    }
});

// 站点名本身就是要隐藏的信息，因此这里不再断言「RavenHash 视频服务」这类带品牌的标签，
// 只断言凭据、域名和路径都不出现，任务 ID 仍然保留。
test('结构化生成错误使用客户端转换后的文案', () => {
    const error = generationFailureError({ error: '请求失败：https://art.ravenhash.org/v1/videos/task_1?token=secret', code: 'DOWNLOAD_FAILED' });
    assert.equal(error.message.includes('token=secret'), false);
    assert.equal(error.message.includes('art.ravenhash.org'), false);
    assert.equal(error.message.includes('/v1/videos'), false);
    assert.match(error.message, /task_1/);
    assert.equal(error.code, 'DOWNLOAD_FAILED');
});

test('a submit-path 404 is not described as a missing generated video', () => {
    const error = generationFailureError({ code: 'RH_INVALID_REQUEST',
        error: '请求参数不受支持，请检查模型、时长、尺寸和素材数量。（HTTP 404）' });
    assert.match(error.message, /提交接口地址不存在/);
    assert.equal(error.message.includes('任务或生成产物不存在'), false);
    assert.match(formatClientGenerationError('查询视频任务 task_1：HTTP 404'), /查询任务失败：任务或生成产物不存在/);
    assert.match(formatClientGenerationError('下载生成产物失败：HTTP 404'), /下载文件暂不可用/);
});

test('portrait rejection metadata survives IPC conversion and does not offer remote recovery', () => {
    const error = generationFailureError({ error: '肖像保护限制', code: 'RH_PORTRAIT_SELF_REQUIRED',
        confirmedFailure: true, retryable: false, requestId: 'trace-id' });
    assert.equal(error.code, 'RH_PORTRAIT_SELF_REQUIRED');
    assert.equal(error.confirmedFailure, true);
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, 'trace-id');
    const task = { kind: 'video', taskId: 'remote', confirmedFailure: true };
    assert.equal(canRecoverGenerationTask(task), false);
    assert.equal(canRecoverGenerationTask({ ...task, filePath: 'completed.mp4' }), true);
    assert.equal(canRecoverGenerationTask({ kind: 'video', taskId: 'unknown-submit' }), true);
});

test('elapsed time handles minutes, hours, future and invalid timestamps', () => {
    assert.equal(formatGenerationElapsed(1000, 1000), '00:00');
    assert.equal(formatGenerationElapsed(1000, 62999), '01:01');
    assert.equal(formatGenerationElapsed(1000, 3662000), '1:01:01');
    assert.equal(formatGenerationElapsed(2000, 1000), '00:00');
    assert.equal(formatGenerationElapsed(undefined, 90000), '00:00');
});

test('recovery stays active through queue, generation, and download, but not after cancel', () => {
    for (const syncStage of ['recovering', 'queued', 'processing', 'download', 'completed']) {
        assert.equal(isGenerationRecoveryActive({ status: 'running', params: { syncStage, recoveryStartedAt: 1000 } }), true);
    }
    for (const status of ['failed', 'disconnected', 'canceled', 'success']) {
        assert.equal(isGenerationRecoveryActive({ status, params: { recoveryStartedAt: 1000 } }), false);
    }
    assert.equal(isGenerationRecoveryActive({ status: 'running', params: { syncStage: 'processing' } }), false);
});

test('image and video recovery can use either a remote task ID or a downloaded checkpoint', () => {
    for (const kind of ['image', 'video']) {
        assert.equal(canRecoverGenerationTask({ kind, taskId: 'remote' }), true);
        assert.equal(canRecoverGenerationTask({ kind, filePath: 'output.png' }), true);
        assert.equal(canRecoverGenerationTask({ kind }), false);
    }
});

test('structured numeric errors survive repeated formatting without exposing arbitrary text', () => {
    const raw = { protocolVersion: 2, code: 'LOCAL_MODEL_PARAMETER_INVALID', category: 'parameter',
        stage: 'validate', submissionState: 'not_submitted', action: 'edit_parameters', requestId: 'fc_12345678',
        error: 'supplier: private-company https://private.test sk-secret cost 0.42 RMB',
        parameterIssues: [{ field: 'duration', rule: 'range', min: 1, max: 12, actual: 15, resolution: '720p' }] };
    const error = generationFailureError(raw);
    assert.match(error.message, /720p 视频时长应为 1 到 12 秒，当前为 15 秒/);
    assert.match(error.message, /尚未提交/);
    assert.equal(error.protocolVersion, 2);
    for (const value of [error, error.message, { ...raw, error: error.message }]) {
        assert.equal(formatClientGenerationError(value), error.message);
        assert.doesNotMatch(formatClientGenerationError(value), /private|supplier|secret|cost|0\.42/);
    }
    const malicious = '分辨率仅支持 supplier。\n本次请求尚未提交。';
    assert.doesNotMatch(formatClientGenerationError(malicious), /supplier/);
    assert.doesNotMatch(formatClientGenerationError(error.message + '\nsupplier: secret'), /supplier|secret/);
});

test('structured future codes show safe generic categories and preserve no-resubmit state', () => {
    const error = generationFailureError({ protocolVersion: 2, code: 'RH_NEW_UNKNOWN_ERROR', category: 'asset',
        stage: 'submit', submissionState: 'unknown', action: 'contact_support',
        error: 'vendor secret', parameterIssues: [{ field: 'image_count', rule: 'max', max: 9, actual: 10 }] });
    assert.match(error.message, /参考图片数量最多 9，当前为 10/);
    assert.match(error.message, /不要重复提交/);
    assert.equal(error.submissionUnknown, true);
    assert.equal(formatClientGenerationError(error.message), error.message);
});
