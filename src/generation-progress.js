export function formatGenerationElapsed(startedAt, now = Date.now()) {
    const start = Number(startedAt);
    const seconds = Number.isFinite(start) && start > 0 ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
    const minutes = Math.floor(seconds / 60);
    const pad = value => String(value).padStart(2, '0');
    return minutes < 60 ? `${pad(minutes)}:${pad(seconds % 60)}`
        : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
}

export function isGenerationRecoveryActive(task) {
    return task?.status === 'running'
        && (Number(task.params?.recoveryStartedAt) > 0 || task.params?.syncStage === 'recovering');
}

export function canRecoverGenerationTask(task) {
    return ['image', 'video'].includes(task?.kind)
        && Boolean(task.filePath || (task.taskId && !isGenerationFailureConfirmed(task)));
}

export function isGenerationFailureConfirmed(task) {
    return task?.confirmedFailure === true || task?.errorCode === 'UPSTREAM_TASK_FAILED'
        || Boolean(getGenerationRejectionInfo(task?.errorCode));
}

const REJECTION_INFO = Object.freeze({
    RH_PORTRAIT_SELF_REQUIRED: { stage: 'portrait_rejected', label: '肖像保护限制' },
    RH_PORTRAIT_RESTRICTED: { stage: 'portrait_rejected', label: '肖像保护限制' },
    RH_REFERENCE_COPYRIGHT: { stage: 'copyright_rejected', label: '参考素材版权限制' },
    RH_COPYRIGHT_REJECTED: { stage: 'copyright_rejected', label: '版权审核未通过' },
    RH_PROMPT_REJECTED: { stage: 'prompt_moderation_failed', label: '提示词审核未通过' },
    RH_REFERENCE_REJECTED: { stage: 'reference_rejected', label: '参考素材审核未通过' },
    RH_OUTPUT_REJECTED: { stage: 'output_rejected', label: '生成结果审核未通过' },
    RH_CONTENT_REJECTED: { stage: 'content_rejected', label: '内容审核未通过' }
});

export function getGenerationRejectionInfo(code) {
    return Object.hasOwn(REJECTION_INFO, code || '') ? REJECTION_INFO[code] : null;
}

export function generationFailureError(result, fallbackMessage = '请求失败') {
    const error = new Error(result?.error || fallbackMessage);
    for (const key of ['code', 'requestId', 'taskId', 'retryable']) {
        if (result?.[key] !== undefined) error[key] = result[key];
    }
    error.confirmedFailure = isGenerationFailureConfirmed({ confirmedFailure: result?.confirmedFailure, errorCode: result?.code });
    if (result?.submissionUnknown === true) error.submissionUnknown = true;
    return error;
}
