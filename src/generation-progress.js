import publicErrors from '../shared/public-api-error.cjs';
import errorRedaction from '../shared/error-redaction.cjs';

const { CATALOG, safeTaskId } = publicErrors;
const { redactSensitiveText } = errorRedaction;

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

const PUBLIC_MESSAGES = Object.values(CATALOG).map(([, message]) => message);
const GENERIC_CLIENT_FAILURE = '请求未能完成，请稍后重试。';
const LOCAL_MESSAGE_PATTERNS = [
    /^(?:模型 [\w.-]+ 已暂时停用，请选择其他渠道；已有任务仍可恢复。|素材文件不存在)$/,
    /^(?:(?:Seedance(?: 2\.[05])?(?: Pro)?|HM-Seedance[\w. -]*|MiniMax H3|StarFrame|GlobalAiOpc|ch0107-sd-2\.5-720p) )?(?:最多支持 \d+ (?:张参考图片|个参考视频|段参考音频)|(?:Pro )?仅支持 (?:480p 或 720p|720p)|(?:视频)?时长(?:仅支持|必须为|必须在) \d+ (?:到 \d+ 秒的整数|到 \d+ 秒之间)|不支持画幅比例 (?:\d+:\d+|adaptive))$/,
    /^(?:没有上游任务 ID，请从服务商后台复制任务 ID 后拉取；不会重新提交生成|请先恢复原任务使用的 API 配置|恢复必须使用原任务的 API 账号|画板恢复服务尚未就绪，产物已保留)$/,
    /^(?:下载地址已失效或无访问权限|下载文件暂不可用|产物下载失败)，可在任务记录中继续拉取，无需重新生成(?:（任务 [\w-]+）)?$/,
    /^提交接口地址不存在，请检查 API 地址；程序更新后需要重启以加载最新适配$/
];

export function formatClientStatusMessage(value) {
    return redactSensitiveText(value);
}

/**
 * 主进程错误可能包含上游产物地址、渠道名或响应体原文。
 *
 * 这里是白名单：先剥掉 URL 和明显的机器可读负载，再判断剩下的文案是否可信。
 * 不可信的一律替换成通用文案，只保留任务标识和排查编号供用户反馈。
 */
export function formatClientGenerationError(value) {
    const details = value && typeof value === 'object' ? value : {};
    const original = String(details.error || details.message || (typeof value === 'string' ? value : '') || '');
    if (!original.trim()) return '';

    // 任务 ID 与排查编号必须在剥 URL 之前取出：它们常嵌在上游产物地址的路径里，
    // 而这两个标识本身不敏感，却是任务恢复和用户反馈的唯一线索。
    const task = safeTaskId(details.taskId) || safeTaskId(original.match(/\btask_[\w-]+\b/i)?.[0]) || '';
    const trace = safeTaskId(details.requestId) || safeTaskId(original.match(/(?:请求编号|排查编号)：\s*([\w-]+)/)?.[1])
        || original.match(/\brh_[a-f0-9]{32}\b/i)?.[0] || '';
    const taskText = task ? `（任务 ${task}）` : '';
    const traceText = trace ? `\n排查编号：${trace}` : '';

    // 上游地址不再区分站点名——一律收敛为服务类别，避免暴露具体域名。
    const message = redactSensitiveText(original);
    if (details.submissionUnknown === true || details.code === 'RH_SUBMISSION_UNKNOWN'
        || original.includes(CATALOG.RH_SUBMISSION_UNKNOWN[1])
        || (/^(?:连接在返回有效响应前被关闭|连接中断，无法确认服务端)/.test(original)
            && original.includes('不要连续重复生成'))) {
        return `${CATALOG.RH_SUBMISSION_UNKNOWN[1]}${taskText}${traceText}`;
    }

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
        const reason = [401, 403].includes(Number(httpStatus)) ? '下载地址已失效或无访问权限'
            : Number(httpStatus) === 404 ? '下载文件暂不可用' : '产物下载失败';
        return `${reason}，可在任务记录中继续拉取，无需重新生成${task ? `（任务 ${task}）` : ''}`;
    }
    if (httpStatus === '404' && /请求参数不受支持|invalid\s+(?:url|request\s+path)/i.test(message)) {
        return '提交接口地址不存在，请检查 API 地址；程序更新后需要重启以加载最新适配';
    }
    if (Object.hasOwn(CATALOG, details.code || '')) return `${CATALOG[details.code][1]}${taskText}${traceText}`;
    const catalogMessage = PUBLIC_MESSAGES.find(text => original.includes(text));
    if (catalogMessage) return `${catalogMessage}${taskText}${traceText}`;
    if (httpStatus) return `${action}：${httpMessages[httpStatus]}${taskText}${traceText}`;
    if (/ERR_[A-Z_]+|ENOTFOUND|ECONNRESET|fetch failed|socket hang up|网络请求失败|连接超时/i.test(message)) {
        return `${action}：网络请求失败，请稍后重试${taskText}${traceText}`;
    }
    // 白名单兜底：无法确认来源的文案不展示原文，只保留可反馈的标识。
    if (!LOCAL_MESSAGE_PATTERNS.some(pattern => pattern.test(original))) return `${action}：${GENERIC_CLIENT_FAILURE}${taskText}${traceText}`;
    // 可信文案原样保留，但任务 ID 可能刚随 URL 一起被替换掉，缺失时补回。
    return task && !message.includes(task) ? `${message}${taskText}` : message;
}

export function generationFailureError(result, fallbackMessage = '请求失败') {
    const error = new Error(formatClientGenerationError({ ...result, error: result?.error || fallbackMessage }));
    for (const key of ['code', 'requestId', 'taskId', 'retryable']) {
        if (result?.[key] !== undefined) error[key] = result[key];
    }
    error.confirmedFailure = isGenerationFailureConfirmed({ confirmedFailure: result?.confirmedFailure, errorCode: result?.code });
    if (result?.submissionUnknown === true) error.submissionUnknown = true;
    return error;
}
