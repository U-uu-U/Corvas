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

const CLIENT_ERROR_URL = /\b(?:https?|wss?|ftp):\/\/[^\s<>"'（）），。；：、]+/gi;

/**
 * 客户端可信文案的白名单。
 *
 * 只有命中这里的模式，才允许把消息原样展示给用户；其余一律降级为通用文案。
 * 这样即便主进程新增了未脱敏的错误分支，也不会直接漏到界面上——
 * 白名单只收「本地判定」和「CATALOG 已经脱敏过」的两类文案。
 */
const TRUSTED_MESSAGE_PATTERNS = [
    // shared/public-api-error.cjs 的 CATALOG 文案特征（审核、额度、限流、肖像、任务语义等）。
    /提示词审核|参考素材审核|生成结果|内容审核|版权保护|肖像保护|审核未通过/,
    /可用额度不足|接口认证失败|无访问权限|请求过于频繁|暂不可用|服务暂时不可用/,
    /素材超过接口大小限制|参考素材无法读取|暂未找到任务|任务未能完成|请求等待超时/,
    /提交结果暂时无法确认|服务响应异常|当前模型不支持|请求参数不受支持|不支持工具调用/,
    // 本地判定与本地校验文案。
    /本地|画布|素材文件|配置|未配置|请先|已取消|已保存|尚未初始化|不存在|为空/,
    /网络请求失败|连接超时|连接中断|结果未知|请稍后重试|排查编号/,
    /图片生成服务|视频生成服务|文字模型服务|视觉理解服务|素材上传服务|生成产物服务|远程服务/
];

const GENERIC_CLIENT_FAILURE = '请求未能完成，请稍后重试。';

function isTrustedClientMessage(message) {
    return TRUSTED_MESSAGE_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * 主进程错误可能包含上游产物地址、渠道名或响应体原文。
 *
 * 这里是白名单：先剥掉 URL 和明显的机器可读负载，再判断剩下的文案是否可信。
 * 不可信的一律替换成通用文案，只保留任务标识和排查编号供用户反馈。
 */
export function formatClientGenerationError(value) {
    const original = String(value || '');
    if (!original.trim()) return GENERIC_CLIENT_FAILURE;

    // 任务 ID 与排查编号必须在剥 URL 之前取出：它们常嵌在上游产物地址的路径里，
    // 而这两个标识本身不敏感，却是任务恢复和用户反馈的唯一线索。
    const task = original.match(/\btask_[\w-]+\b/i)?.[0] || '';
    const trace = original.match(/\brh_[a-f0-9]{32}\b/i)?.[0] || '';
    const taskText = task ? `（任务 ${task}）` : '';
    const traceText = trace ? `\n排查编号：${trace}` : '';

    // 上游地址不再区分站点名——一律收敛为服务类别，避免暴露具体域名。
    const message = original
        .replace(CLIENT_ERROR_URL, '远程服务')
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[已隐藏]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]')
        .replace(/\{[^{}]*"[^"]+"\s*:[^{}]*\}/g, '[已隐藏]');

    const action = message.includes('下载生成产物失败') ? '下载生成产物失败'
        : message.includes('查询视频任务') || message.includes('查询任务') ? '查询任务失败'
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
        return `生成已完成，但产物下载失败，系统已自动刷新下载地址${taskText}`;
    }
    if (httpStatus) return `${action}：${httpMessages[httpStatus]}${taskText}${traceText}`;
    if (/ERR_[A-Z_]+|ENOTFOUND|ECONNRESET|fetch failed|socket hang up|网络请求失败|连接超时/i.test(message)) {
        return `${action}：网络请求失败，请稍后重试${taskText}`;
    }
    // 白名单兜底：无法确认来源的文案不展示原文，只保留可反馈的标识。
    if (!isTrustedClientMessage(message)) return `${action}：${GENERIC_CLIENT_FAILURE}${taskText}${traceText}`;
    // 可信文案原样保留，但任务 ID 可能刚随 URL 一起被替换掉，缺失时补回。
    return task && !message.includes(task) ? `${message}${taskText}` : message;
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
