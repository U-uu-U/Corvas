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

const CLIENT_ERROR_URL = /https?:\/\/[^\s<>"'（）），。；：、]+/gi;

function clientServiceLabel(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (host === 'video.zhubo.asia') return '视频中转服务';
    if (host === 'art.ravenhash.org') return 'RavenHash 视频服务';
    if (host === 'ai.ravenhash.org') return 'RavenHash AI 服务';
    return '远程服务';
}

/**
 * 主进程错误可能包含上游产物地址。客户端只展示服务类型和任务标识，
 * 不把上游站点名、路径或查询参数直接带给用户。
 */
export function formatClientGenerationError(value) {
    const original = String(value || '');
    const message = original.replace(CLIENT_ERROR_URL, rawUrl => {
        const trimmed = rawUrl.replace(/[，。；：、,.;:]+$/g, '');
        try {
            const url = new URL(trimmed);
            const lastSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
            const taskId = /^task_[\w-]+$/i.test(lastSegment) ? `任务 ${lastSegment}` : '';
            return taskId ? `${clientServiceLabel(url.hostname)}（${taskId}）` : clientServiceLabel(url.hostname);
        } catch (_) {
            return '远程服务';
        }
    });

    const task = message.match(/\btask_[\w-]+\b/i)?.[0] || '';
    const action = message.includes('下载生成产物失败') ? '下载生成产物失败'
        : message.includes('查询视频任务') ? '查询任务失败'
            : message.includes('生成') ? '生成失败' : '请求失败';
    const httpStatus = message.match(/\bHTTP\s+(400|401|402|403|404|408|413|422|429|500|502|503|504)\b/i)?.[1];
    const httpMessages = {
        400: '请求参数不合法，请检查模型参数',
        401: '接口认证失败，请检查 API 配置',
        402: '账户额度不足，请检查 API 账户',
        403: '当前 API 没有访问权限',
        404: '任务或生成产物不存在',
        408: '服务响应超时，请稍后重试',
        413: '素材超过接口大小限制',
        422: '请求参数不被服务接受',
        429: '请求过于频繁，请稍后重试',
        500: '服务暂时不可用，请稍后重试',
        502: '服务响应异常，请稍后重试',
        503: '服务暂时不可用，请稍后重试',
        504: '服务响应超时，请稍后重试'
    };
    if (httpStatus && action === '下载生成产物失败') {
        const reason = [401, 403].includes(Number(httpStatus)) ? '下载地址已失效或无访问权限'
            : Number(httpStatus) === 404 ? '下载文件暂不可用' : '产物下载失败';
        return `${reason}，可在任务记录中继续拉取，无需重新生成${task ? `（任务 ${task}）` : ''}`;
    }
    if (httpStatus === '404' && /请求参数不受支持|invalid\s+(?:url|request\s+path)/i.test(message)) {
        return '提交接口地址不存在，请检查 API 地址；程序更新后需要重启以加载最新适配';
    }
    if (httpStatus) return `${action}：${httpMessages[httpStatus]}${task ? `（任务 ${task}）` : ''}`;
    if (/ERR_CONNECTION|ERR_TIMED_OUT|ENOTFOUND|fetch failed|网络请求失败|连接超时/i.test(message)) {
        return `${action}：网络请求失败，请稍后重试${task ? `（任务 ${task}）` : ''}`;
    }
    return message;
}

export function generationFailureError(result, fallbackMessage = '请求失败') {
    const error = new Error(formatClientGenerationError(result?.error || fallbackMessage));
    for (const key of ['code', 'requestId', 'taskId', 'retryable']) {
        if (result?.[key] !== undefined) error[key] = result[key];
    }
    error.confirmedFailure = isGenerationFailureConfirmed({ confirmedFailure: result?.confirmedFailure, errorCode: result?.code });
    if (result?.submissionUnknown === true) error.submissionUnknown = true;
    return error;
}
