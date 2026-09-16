import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGenerationElapsed, isGenerationRecoveryActive, canRecoverGenerationTask, generationFailureError,
    formatClientGenerationError } from './generation-progress.js';

test('客户端错误展示会隐藏上游站点并保留任务标识', () => {
    const message = formatClientGenerationError('下载生成产物失败（https://video.zhubo.asia/v1/videos/task_9151，已尝试 1 次）：HTTP 401');
    assert.equal(message, '生成已完成，但产物下载失败，系统已自动刷新下载地址（任务 task_9151）');
    assert.equal(message.includes('video.zhubo.asia'), false);
});

test('结构化生成错误使用客户端转换后的文案', () => {
    const error = generationFailureError({ error: '请求失败：https://art.ravenhash.org/v1/videos/task_1?token=secret', code: 'DOWNLOAD_FAILED' });
    assert.match(error.message, /RavenHash 视频服务（任务 task_1）/);
    assert.equal(error.message.includes('token=secret'), false);
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
