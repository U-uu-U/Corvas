const { normalizeParameterIssues, normalizePublicDetail, safeRequestId, formatPublicDetail } = require('./public-error-detail.cjs');
const { prepareCustomerMessage, extractErrorReasons } = require('./customer-error-message.cjs');

const CATALOG = Object.freeze({
    RH_ASSET_PENDING: [409, '参考素材仍在审核，尚未提交视频任务；稍后重试会复用素材 ID。'],
    RH_MODEL_ENDPOINT_MISMATCH: [400, '当前模型不支持这类调用。请检查节点或 Agent 选择的模型；文字分析需要文字或视觉理解模型，不能使用图片生成模型。'],
    RH_REFERENCE_COPYRIGHT: [400, '参考素材触发版权保护，审核未通过。请更换为有权使用且符合模型要求的素材后重新提交。'],
    RH_COPYRIGHT_REJECTED: [400, '本次生成触发版权保护，审核未通过。请检查提示词与参考素材，调整后重新提交。'],
    RH_PROMPT_REJECTED: [400, '提示词审核未通过，请修改提示词后重新提交。'],
    RH_REFERENCE_REJECTED: [400, '参考素材审核未通过，请更换或调整参考素材后重新提交。'],
    RH_OUTPUT_REJECTED: [400, '生成结果未通过内容审核，未返回可用产物。请调整提示词或参考素材后重新提交。'],
    RH_PORTRAIT_SELF_REQUIRED: [400, '参考图触发肖像保护限制：当前模型仅支持生成包含本人肖像的视频。请更换符合要求的参考图，或移除参考图改用纯文字生成。'],
    RH_PORTRAIT_RESTRICTED: [400, '参考图未通过人脸或肖像保护检查。请更换符合当前模型要求的参考图，或移除参考图改用纯文字生成。'],
    RH_INVALID_REQUEST: [400, '\u8bf7\u6c42\u53c2\u6570\u4e0d\u53d7\u652f\u6301\uff0c\u8bf7\u68c0\u67e5\u6a21\u578b\u3001\u65f6\u957f\u3001\u5c3a\u5bf8\u548c\u7d20\u6750\u6570\u91cf\u3002'],
    RH_AUTH_FAILED: [401, '\u63a5\u53e3\u8ba4\u8bc1\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5 API \u914d\u7f6e\u6216\u8054\u7cfb\u7ba1\u7406\u5458\u3002'],
    RH_PERMISSION_DENIED: [403, '\u5f53\u524d\u8bf7\u6c42\u65e0\u8bbf\u95ee\u6743\u9650\uff0c\u8bf7\u68c0\u67e5\u8d26\u6237\u548c\u6a21\u578b\u6743\u9650\u3002'],
    RH_QUOTA_EXHAUSTED: [402, '\u53ef\u7528\u989d\u5ea6\u4e0d\u8db3\uff0c\u8bf7\u68c0\u67e5\u8d26\u6237\u989d\u5ea6\u6216\u8054\u7cfb\u7ba1\u7406\u5458\u3002'],
    RH_RATE_LIMITED: [429, '\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002'],
    RH_MODEL_UNAVAILABLE: [503, '\u5f53\u524d\u6a21\u578b\u6682\u4e0d\u53ef\u7528\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u6216\u9009\u62e9\u5176\u4ed6\u6a21\u578b\u3002'],
    RH_CONTENT_REJECTED: [400, '内容审核未通过，请检查提示词和参考素材，修改后重新提交。'],
    RH_MEDIA_TOO_LARGE: [413, '\u7d20\u6750\u8d85\u8fc7\u63a5\u53e3\u5927\u5c0f\u9650\u5236\uff0c\u8bf7\u538b\u7f29\u7d20\u6750\u540e\u518d\u8bd5\u3002'],
    RH_MEDIA_UNREADABLE: [400, '\u53c2\u8003\u7d20\u6750\u65e0\u6cd5\u8bfb\u53d6\uff0c\u8bf7\u91cd\u65b0\u4e0a\u4f20\u6216\u66f4\u6362\u7d20\u6750\u3002'],
    RH_TASK_NOT_FOUND: [404, '\u6682\u672a\u627e\u5230\u4efb\u52a1\uff0c\u8bf7\u6838\u5bf9\u4efb\u52a1 ID \u548c\u539f API \u8d26\u6237\uff0c\u7a0d\u540e\u91cd\u65b0\u67e5\u8be2\u3002'],
    RH_TASK_FAILED: [502, '\u4efb\u52a1\u672a\u80fd\u5b8c\u6210\uff0c\u8bf7\u6839\u636e\u6392\u67e5\u7f16\u53f7\u8054\u7cfb\u7ba1\u7406\u5458\u3002'],
    RH_SERVICE_UNAVAILABLE: [503, '\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u67e5\u8be2\u3002'],
    RH_REQUEST_TIMEOUT: [504, '\u8bf7\u6c42\u7b49\u5f85\u8d85\u65f6\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u67e5\u8be2\u3002'],
    RH_SUBMISSION_UNKNOWN: [502, '\u63d0\u4ea4\u7ed3\u679c\u6682\u65f6\u65e0\u6cd5\u786e\u8ba4\uff0c\u4efb\u52a1\u53ef\u80fd\u4ecd\u5728\u5904\u7406\u3002\u8bf7\u4f18\u5148\u4f7f\u7528\u539f\u4efb\u52a1 ID \u62c9\u53d6\u4ea7\u7269\uff0c\u4e0d\u8981\u91cd\u590d\u63d0\u4ea4\u3002'],
    RH_INVALID_RESPONSE: [502, '\u670d\u52a1\u54cd\u5e94\u5f02\u5e38\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u67e5\u8be2\u6216\u8054\u7cfb\u7ba1\u7406\u5458\u3002'],
    RH_TOOLS_UNSUPPORTED: [400, '\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301\u5de5\u5177\u8c03\u7528\uff0c\u53ef\u4f7f\u7528\u666e\u901a\u5bf9\u8bdd\u6216\u66f4\u6362\u6a21\u578b\u3002']
});
const WRAPPERS = ['data', 'result', 'output', 'task', 'response', 'Response', 'base_resp', 'baseResp', 'metadata'];
const FAILED = new Set(['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'expired']);
const REASON_FIELDS = ['failReason', 'fail_reason', 'failure_reason', 'error_message', 'errorMessage', 'status_msg'];
const CONTENT_REJECTION_CODES = new Set(['RH_PORTRAIT_SELF_REQUIRED', 'RH_PORTRAIT_RESTRICTED',
    'RH_REFERENCE_COPYRIGHT', 'RH_COPYRIGHT_REJECTED', 'RH_PROMPT_REJECTED',
    'RH_REFERENCE_REJECTED', 'RH_OUTPUT_REJECTED', 'RH_CONTENT_REJECTED']);
const own = (value, key) => value && Object.hasOwn(value, key);

function parsePayload(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
}

function failureNode(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return null;
    if (Array.isArray(value)) return value.map(entry => failureNode(entry, depth + 1)).find(Boolean) || null;
    const state = String(value.status || value.task_status || '').toLowerCase();
    const code = value.code ?? value.status_code;
    const error = value.error || value.Error;
    const hasError = typeof error === 'string' ? Boolean(error.trim()) : error === true
        || (error && typeof error === 'object' && !Array.isArray(error) && Boolean(error.message || error.msg || error.code || error.type || error.reason || error.detail));
    const hasFailureReason = REASON_FIELDS.filter(key => key !== 'status_msg')
        .some(key => typeof value[key] === 'string' && value[key].trim());
    const hasErrors = Array.isArray(value.errors) && value.errors.some(item => typeof item === 'string' ? item.trim()
        : item && typeof item === 'object' && (item.message || item.msg || item.detail || item.reason || item.code));
    if (FAILED.has(state) || value.success === false || value.ok === false || value.type === 'error'
        || value.type === 'response.failed' || hasError || hasErrors || hasFailureReason
        || (code != null && !['0', '1', '200', '201', '202', '10000', 'ok', 'success'].includes(String(code).toLowerCase())
            && (value.message || value.msg || value.description || value.status_msg))) return value;
    for (const key of WRAPPERS) {
        const failed = failureNode(value[key], depth + 1);
        if (failed) return failed;
    }
    return null;
}

function safeTaskId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
        && !/^(sk-|bearer|basic)/i.test(value) ? value : null;
}

function findTaskId(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return null;
    for (const key of ['task_id', 'taskId', 'id', 'TaskId']) {
        const id = safeTaskId(value[key]);
        if (id) return id;
    }
    for (const key of WRAPPERS) {
        const id = findTaskId(value[key], depth + 1);
        if (id) return id;
    }
    return null;
}

function isTerminalFailure(value) {
    const node = failureNode(value);
    return Boolean(node && FAILED.has(String(node.status || node.task_status || '').toLowerCase()));
}

// Only classify error fields. Never inspect prompts, model output or media content.
function errorText(value, depth = 0) {
    if (depth > 8) return '';
    if (Array.isArray(value)) return value.map(entry => errorText(entry, depth + 1)).join(' ').slice(0, 16384);
    const node = failureNode(value) || value;
    if (typeof node === 'string') return node.slice(0, 16384);
    if (!node || typeof node !== 'object') return '';
    const direct = ['error', 'Error', 'code', 'type', 'message', 'msg', 'description', 'reason', 'detail', ...REASON_FIELDS]
        .filter(key => own(node, key)).map(key => {
            const field = node[key];
            if (typeof field === 'string' || typeof field === 'number') return String(field);
            if (field && typeof field === 'object') return errorText(field, depth + 1);
            return '';
        }).join(' ');
    const nested = WRAPPERS.map(key => {
        const nestedValue = node[key];
        const failed = failureNode(nestedValue);
        return failed ? errorText(failed, depth + 1)
            : isTerminalFailure(node) && nestedValue && typeof nestedValue === 'object'
                ? errorText(nestedValue, depth + 1) : '';
    }).join(' ');
    return `${direct} ${nested}`.slice(0, 16384);
}

function classify(status, value, { query = false, terminal = false, transport = false } = {}) {
    const text = errorText(value);
    // A completed routing rejection is distinct from a lost POST response.
    if (!transport && !findTaskId(value) && /\bmodel_not_found\b/i.test(text)
        && /no available channel for model/i.test(text)) return 'RH_MODEL_UNAVAILABLE';
    // An uncertain POST must never turn into an invitation to automatically resubmit.
    if (!query && !terminal && (transport || status === 408 || status >= 500)) return 'RH_SUBMISSION_UNKNOWN';
    if (/not supported on (?:the )?chat completions endpoint|(?:does not support|unsupported).{0,30}chat[ _-]?completions|chat[ _-]?completions.{0,30}(?:not supported|unsupported)/i.test(text)) return 'RH_MODEL_ENDPOINT_MISMATCH';
    if (/(?:只|仅)支持生成包含(?:您|你)自己(?:的|肖像|人脸)|仅支持(?:本人|自己)(?:的)?肖像|only\s+(?:supports?\s+)?(?:generat\w+\s+)?videos?\s+(?:of|featuring|containing)\s+(?:you\b|yourself\b)|only.{0,60}(?:your own likeness|your own face)/i.test(text)) return 'RH_PORTRAIT_SELF_REQUIRED';
    if (/肖像保护|人脸.{0,16}(?:保护|限制|不支持|禁止)|(?:portrait|likeness)\s+protection|(?:real(?:istic)?[ -]?(?:people|person|face)|human[ -]?faces?).{0,40}(?:not supported|not allowed|prohibited|restricted)/i.test(text)) return 'RH_PORTRAIT_RESTRICTED';
    const rejected = /未通过|不通过|不予通过|未能通过|违规|违反|拒绝|不允许|禁止|(?:审核|审查|检测|检查|校验).{0,8}失败|reject(?:ed|ion)?|violat(?:ion|es?|ed)|not[_ -]?(?:allowed|supported|pass)|fail(?:ed|ure)?|block(?:ed)?|prohibit(?:ed)?/i;
    const references = /参考(?:图|素材|图片|视频|音频)|素材|(?:input|reference|uploaded)[_ -]?(?:image|video|audio|media)|image_urls|输入(?:图|素材)/i;
    const copyright = /版权|著作权|侵权|copyright|intellectual[_ -]?property/i;
    const reviewUnavailable = /(?:审核|审查|版权|moderation|copyright|safety).{0,30}(?:服务|service|server|接口).{0,20}(?:不可用|超时|异常|失败|unavailable|timeout|timed out|failed)/i.test(text);
    if (!reviewUnavailable && copyright.test(text) && (rejected.test(text) || /保护|包含|含有|protected|copyrighted/i.test(text))) {
        return references.test(text) ? 'RH_REFERENCE_COPYRIGHT' : 'RH_COPYRIGHT_REJECTED';
    }
    const moderation = /审核|审查|内容安全|安全检查|content[_ .-]?(?:policy|filter|moderation|review)|safety[_ .-]?(?:check|filter)|moderation|nsfw/i;
    const contentRejected = !reviewUnavailable && ((moderation.test(text) && rejected.test(text))
        || /content_policy_violation|content_filter(?:ed)?\b|nsfw|违规/i.test(text));
    if (contentRejected) {
        if (/生成(?:的)?(?:结果|内容|视频|图片)|产物|(?:generated|output)[_ -]?(?:image|video|content|media|result)|结果审核/i.test(text)) return 'RH_OUTPUT_REJECTED';
        if (references.test(text)) return 'RH_REFERENCE_REJECTED';
        if (/提示词|\bprompt\b|prompt[_ .-]/i.test(text)) return 'RH_PROMPT_REJECTED';
        return 'RH_CONTENT_REJECTED';
    }
    const referenceDuration = /(?:reference|input|uploaded)[_ -]?(?:audio|video)|audio[_ -]?duration|video[_ -]?duration|参考(?:音频|视频)|音频.{0,12}时长|视频.{0,12}时长/i;
    const durationLimit = /duration.{0,80}(?:exceed|too long|too short|out of range|maximum|minimum|between|greater than|less than|at most|at least)|(?:exceed|maximum|minimum|too long|too short).{0,40}duration|时长.{0,40}(?:超|大于|小于|不足|范围|限制|最多|至少)|(?:超出|超过).{0,30}(?:秒|时长)/i;
    if (referenceDuration.test(text) && durationLimit.test(text)) return 'RH_INVALID_REQUEST';
    if (/(?:图片|图像|image).{0,40}(?:尺寸|宽高|宽度|高度|dimension|aspect.?ratio).{0,50}(?:不符合|必须|需在|限制|invalid|between|must|range|exceed)/i.test(text)) return 'RH_INVALID_REQUEST';
    if (/insufficient[_ -]?(quota|balance|credit)|quota[_ -]?exceeded|\u4f59\u989d\u4e0d\u8db3|\u989d\u5ea6\u4e0d\u8db3/i.test(text) || status === 402) return 'RH_QUOTA_EXHAUSTED';
    if (/invalid[_ -]?(api[_ -]?key|token)|authentication|unauthorized|\u8ba4\u8bc1.*\u5931\u8d25|\u65e0\u6548.*(?:key|token)/i.test(text)) return 'RH_AUTH_FAILED';
    if (/\b(tools?|tool_choice|function[_ -]?calling)\b.*(unsupported|not supported|unknown|not allowed)/i.test(text)) return 'RH_TOOLS_UNSUPPORTED';
    if (status === 413 || /payload too large|image.*too large|\u7d20\u6750.*\u8fc7\u5927/i.test(text)) return 'RH_MEDIA_TOO_LARGE';
    if (/invalid[_ -]?(image|video|audio)|failed to (download|fetch).*image|image.*(unreachable|unreadable)|\u7d20\u6750.*\u65e0\u6cd5\u8bfb\u53d6/i.test(text)) return 'RH_MEDIA_UNREADABLE';
    if (status === 401) return 'RH_AUTH_FAILED';
    if (status === 403) return 'RH_PERMISSION_DENIED';
    if (status === 429 || /rate[_ -]?limit|too many requests|\u9650\u6d41/i.test(text)) return 'RH_RATE_LIMITED';
    if (status === 404 && query) return 'RH_TASK_NOT_FOUND';
    if (/model[_ -]?not[_ -]?found|no available channel|model.*unavailable|\u6a21\u578b.*\u4e0d\u53ef\u7528/i.test(text)) return 'RH_MODEL_UNAVAILABLE';
    if (status === 400 || status === 422 || /invalid[_ -]?(parameter|argument|request)|unsupported.*(size|duration|resolution)/i.test(text)) return 'RH_INVALID_REQUEST';
    if (terminal) return 'RH_TASK_FAILED';
    if (status === 408 || status === 504 || transport) return 'RH_REQUEST_TIMEOUT';
    return 'RH_SERVICE_UNAVAILABLE';
}

function publicFailure(status, payload, options = {}) {
    const value = parsePayload(payload) || payload;
    const explicitFailure = options.terminal === true || (status < 400 && isTerminalFailure(value));
    const code = Object.hasOwn(CATALOG, options.code || '') ? options.code : classify(status, value, { ...options, terminal: explicitFailure });
    const terminal = explicitFailure || CONTENT_REJECTION_CODES.has(code);
    const requestId = /^rh_[a-f0-9]{32}$/.test(options.requestId || '') ? options.requestId : null;
    const unknown = code === 'RH_SUBMISSION_UNKNOWN';
    const error = { type: 'ravenhash_error', code, message: CATALOG[code][1],
        retryable: options.query === true && !terminal && ['RH_RATE_LIMITED', 'RH_TASK_NOT_FOUND', 'RH_SERVICE_UNAVAILABLE', 'RH_REQUEST_TIMEOUT'].includes(code),
        submissionUnknown: unknown };
    if (requestId) error.request_id = requestId;
    const body = { error };
    const taskId = safeTaskId(options.taskId) || (terminal ? findTaskId(value) : safeTaskId(value?.task_id));
    if (taskId) Object.assign(body, { id: taskId, task_id: taskId });
    if (terminal) body.status = 'failed';
    return { status: terminal && taskId ? 200 : status >= 400 && status <= 599 ? status : CATALOG[code][0], body };
}

// Clients validate customerMessage separately; the legacy echoed message is never trusted.
function readPublicError(payload) {
    const value = parsePayload(payload);
    const node = failureNode(value);
    const error = node?.error;
    if (error?.type === 'ravenhash_error' && error.protocolVersion === 2) {
        const detail = normalizePublicDetail(error);
        const taskId = findExplicitTaskId(value);
        return { ...detail, taskId, message: formatPublicDetail(detail, CATALOG) };
    }
    if (error?.type !== 'ravenhash_error' || !Object.hasOwn(CATALOG, error.code)) return null;
    const requestId = /^rh_[a-f0-9]{32}$/.test(error.request_id || '') ? error.request_id : null;
    const confirmedFailure = isTerminalFailure(value) || CONTENT_REJECTION_CODES.has(error.code);
    return { code: error.code, requestId, submissionUnknown: error.code === 'RH_SUBMISSION_UNKNOWN',
        taskId: findTaskId(value), confirmedFailure,
        retryable: !confirmedFailure && error.retryable === true,
        message: CATALOG[error.code][1] + (requestId ? `\n\u6392\u67e5\u7f16\u53f7\uff1a${requestId}` : '') };
}

function publicErrorResult(payload) {
    const error = readPublicError(payload);
    if (error?.protocolVersion === 2) {
        const { message, ...details } = error;
        return { success: false, error: message, ...details };
    }
    return error ? { success: false, error: error.message, code: error.code, requestId: error.requestId,
        submissionUnknown: error.submissionUnknown, retryable: error.retryable,
        taskId: error.taskId, confirmedFailure: error.confirmedFailure } : null;
}

function mapLocalError(status, payload, options = {}) {
    const mapped = readPublicError(payload);
    if (mapped?.protocolVersion === 2) {
        const { message, ...details } = mapped;
        return { success: false, error: message, ...details, taskId: mapped.taskId || safeTaskId(options.taskId) };
    }
    if (!mapped && (options.protocolVersion === 2 || ['upstream', 'client_account'].includes(options.origin))) {
        return publicErrorResult(normalizeRelayFailure(Number(status) || 502, payload, options).body);
    }
    const statusCode = Number(status) || 502;
    const statusSuffix = statusCode >= 400 && statusCode <= 599 ? `（HTTP ${statusCode}）` : '';
    if (mapped) return {
        success: false, error: mapped.message + statusSuffix, code: mapped.code, requestId: mapped.requestId,
        submissionUnknown: mapped.submissionUnknown, retryable: options.terminal ? false : mapped.retryable,
        taskId: mapped.taskId || safeTaskId(options.taskId), confirmedFailure: mapped.confirmedFailure || options.terminal === true
    };
    const result = publicFailure(statusCode, payload, options);
    return {
        success: false,
        error: result.body.error.message + statusSuffix + (result.body.error.request_id ? `\n\u6392\u67e5\u7f16\u53f7\uff1a${result.body.error.request_id}` : ''),
        code: result.body.error.code,
        requestId: result.body.error.request_id,
        submissionUnknown: result.body.error.submissionUnknown === true,
        retryable: result.body.error.retryable === true,
        taskId: result.body.task_id,
        confirmedFailure: result.body.status === 'failed'
    };
}

function findExplicitTaskId(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return null;
    for (const key of ['task_id', 'taskId', 'TaskId']) {
        const id = safeTaskId(value[key]);
        if (id) return id;
    }
    for (const key of WRAPPERS) {
        const id = findExplicitTaskId(value[key], depth + 1);
        if (id) return id;
    }
    return null;
}

function categoryForCode(code) {
    if (CONTENT_REJECTION_CODES.has(code)) return 'moderation';
    if (['RH_INVALID_REQUEST', 'RH_MODEL_ENDPOINT_MISMATCH', 'RH_TOOLS_UNSUPPORTED'].includes(code)) return 'parameter';
    if (['RH_MEDIA_TOO_LARGE', 'RH_MEDIA_UNREADABLE', 'RH_ASSET_PENDING'].includes(code)) return 'asset';
    return ({ RH_AUTH_FAILED: 'auth', RH_PERMISSION_DENIED: 'permission', RH_QUOTA_EXHAUSTED: 'quota',
        RH_RATE_LIMITED: 'rate_limit', RH_MODEL_UNAVAILABLE: 'model_unavailable' })[code] || 'service';
}

function extractParameterIssues(payload) {
    const text = errorText(payload);
    const imageIssues = [];
    if (/图片|图像|\bimage\b/i.test(text)) {
        const dimensions = text.match(/(?:宽高(?!比)|宽度和高度|width\s+and\s+height)[^（）(),，;；\n]{0,20}?(\d+)\s*(?:[～~–—-]|到|and|to)\s*(\d+)/i);
        const ratio = text.match(/(?:宽高比|aspect[_ ]?ratio)[^（）(),，;；\n]{0,20}?(\d+(?:\.\d+)?)\s*(?:[～~–—-]|到|and|to)\s*(\d+(?:\.\d+)?)/i);
        if (dimensions) for (const field of ['referenceImageWidth', 'referenceImageHeight']) imageIssues.push({ field, reason: 'range', min: Number(dimensions[1]), max: Number(dimensions[2]) });
        if (ratio) imageIssues.push({ field: 'referenceImageAspectRatio', reason: 'range', min: Number(ratio[1]), max: Number(ratio[2]) });
    }
    const duration = /duration|时长/i.test(text);
    const field = /reference[_ ]?audio|input[_ ]?audio|参考音频|音频.{0,12}时长/i.test(text) ? 'referenceAudioDuration'
        : /reference[_ ]?video|input[_ ]?video|参考视频/i.test(text) ? 'referenceVideoDuration' : 'duration';
    if (!duration) return normalizeParameterIssues(imageIssues);
    const range = text.match(/(?:duration|时长).{0,35}?(?:between|from|支持|范围[为是]?|必须[为在])\s*(\d+(?:\.\d+)?)\s*(?:and|to|到|[-~])\s*(\d+(?:\.\d+)?)/i);
    const maximum = text.match(/(?:duration|时长).{0,40}?(?:maximum(?: of)?|max(?:imum)?[=: ]|at most|最多|上限[为是]?|超过|exceeds?(?: maximum)?)\s*(\d+(?:\.\d+)?)/i);
    const minimum = text.match(/(?:duration|时长).{0,40}?(?:minimum(?: of)?|at least|至少|不足)\s*(\d+(?:\.\d+)?)/i);
    if (!range && !maximum && !minimum) return normalizeParameterIssues(imageIssues);
    const issue = { field, reason: 'range' };
    if (range) Object.assign(issue, { min: Number(range[1]), max: Number(range[2]) });
    else if (maximum) issue.max = Number(maximum[1]);
    else issue.min = Number(minimum[1]);
    const actual = text.match(/(?:received|actual|当前(?:为)?|实际(?:为)?)\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
    if (actual) issue.actual = Number(actual[1]);
    return normalizeParameterIssues([...imageIssues, issue]);
}

function mappedRuleCode(value, rules) {
    if (!Array.isArray(rules)) return null;
    const node = failureNode(value) || value;
    const upstreamCode = node?.error?.code ?? node?.code;
    if (typeof upstreamCode !== 'string' || upstreamCode.length > 256) return null;
    const rule = rules.slice(0, 100).find(candidate => candidate?.upstreamCode === upstreamCode
        && Object.hasOwn(CATALOG, candidate.publicCode));
    return rule?.publicCode || null;
}

// Gateway-only conversion. Raw provider fields are classified here but never returned.
function normalizeRelayFailure(status, payload, options = {}) {
    const value = parsePayload(payload) || payload;
    const query = options.query === true || ['poll', 'download'].includes(options.stage);
    const taskId = safeTaskId(options.taskId) || findExplicitTaskId(value);
    const terminal = options.terminal === true || (query && isTerminalFailure(value));
    const transport = options.transport === true;
    const extracted = extractErrorReasons(value);
    const classificationValue = extracted.length ? { task_id: taskId, error: { message: extracted.map(item => item.text).join('\n') } } : value;
    let code = (Object.hasOwn(CATALOG, options.code || '') ? options.code : null) || mappedRuleCode(value, options.rules)
        || classify(status, classificationValue, { query, terminal, transport });
    const text = errorText(value);
    const routingRejected = !taskId && /\bmodel_not_found\b/i.test(text) && /no available channel for model/i.test(text);
    const ambiguous = !query && !['validate', 'upload'].includes(options.stage)
        && (transport || status === 408 || (status >= 500 && !routingRejected && !terminal));
    if (ambiguous) code = 'RH_SUBMISSION_UNKNOWN';
    const privateAccountFailure = options.origin !== 'client_account' && ['RH_AUTH_FAILED', 'RH_QUOTA_EXHAUSTED', 'RH_PERMISSION_DENIED'].includes(code);
    if (privateAccountFailure) {
        code = 'RH_SERVICE_UNAVAILABLE';
    }
    const category = categoryForCode(code);
    const confirmedFailure = !ambiguous && (terminal || CONTENT_REJECTION_CODES.has(code));
    const submissionState = ambiguous ? 'unknown' : ['validate', 'upload'].includes(options.stage) ? 'not_submitted'
        : taskId || (query && terminal) ? 'accepted' : query ? 'unknown'
            : status >= 400 && status < 500 && status !== 408 ? 'rejected'
            : confirmedFailure || code === 'RH_MODEL_UNAVAILABLE' ? 'rejected' : 'unknown';
    const parameterIssues = ['parameter', 'asset'].includes(category)
        ? normalizeParameterIssues(options.parameterIssues || extractParameterIssues(classificationValue)) : [];
    const customer = prepareCustomerMessage(value, { ...options.customerPolicy, prompts: options.prompts,
        suppress: submissionState === 'unknown' || privateAccountFailure || transport });
    options.onCustomerMessage?.({ ...customer.audit, customerMessage: customer.message || null });
    const action = submissionState === 'unknown' ? (taskId || query ? 'retry_query' : 'contact_support')
        : submissionState === 'accepted' && !confirmedFailure ? 'retry_query'
            : category === 'parameter' || category === 'moderation' ? 'edit_parameters'
                : category === 'asset' ? 'replace_reference'
                    : ['auth', 'quota', 'permission'].includes(category) ? 'check_account'
                        : category === 'rate_limit' ? 'wait' : 'contact_support';
    const detail = normalizePublicDetail({ protocolVersion: 2, code, category,
        stage: options.stage || (query ? 'poll' : 'submit'), submissionState, action, httpStatus: status,
        requestId: safeRequestId(options.requestId), parameterIssues, confirmedFailure, customerMessage: customer.message,
        retryable: query && !confirmedFailure && ['RH_RATE_LIMITED', 'RH_TASK_NOT_FOUND', 'RH_SERVICE_UNAVAILABLE', 'RH_REQUEST_TIMEOUT'].includes(code) });
    const { requestId, ...fields } = detail;
    const error = { type: 'ravenhash_error', ...fields, message: CATALOG[code][1] };
    if (requestId) error.request_id = requestId;
    const body = { error };
    if (taskId) Object.assign(body, { id: taskId, task_id: taskId });
    if (confirmedFailure) body.status = 'failed';
    return { status: confirmedFailure && taskId ? 200 : status >= 400 && status <= 599 ? status : CATALOG[code][0], body };
}

module.exports = { CATALOG, parsePayload, failureNode, isTerminalFailure, safeTaskId, findTaskId,
    publicFailure, readPublicError, publicErrorResult, mapLocalError, errorText, normalizeRelayFailure,
    normalizePublicDetail, normalizeParameterIssues, formatPublicDetail, safeRequestId, findExplicitTaskId };
