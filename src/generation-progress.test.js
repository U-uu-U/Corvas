import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGenerationElapsed, isGenerationRecoveryActive, canRecoverGenerationTask, generationFailureError,
    formatClientGenerationError } from './generation-progress.js';

test('客户端错误展示会隐藏上游站点并保留任务标识', () => {
    const message = formatClientGenerationError('下载生成产物失败（https://video.zhubo.asia/v1/videos/task_9151，已尝试 1 次）：HTTP 401');
    assert.equal(message, '生成已完成，但产物下载失败，系统已自动刷新下载地址（任务 task_9151）');
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
