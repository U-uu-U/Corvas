const CATALOG = Object.freeze({
    RH_PORTRAIT_SELF_REQUIRED: [400, '参考图触发肖像保护限制：当前模型仅支持生成包含本人肖像的视频。请更换符合要求的参考图，或移除参考图改用纯文字生成。'],
    RH_PORTRAIT_RESTRICTED: [400, '参考图未通过人脸或肖像保护检查。请更换符合当前模型要求的参考图，或移除参考图改用纯文字生成。'],
    RH_INVALID_REQUEST: [400, '\u8bf7\u6c42\u53c2\u6570\u4e0d\u53d7\u652f\u6301\uff0c\u8bf7\u68c0\u67e5\u6a21\u578b\u3001\u65f6\u957f\u3001\u5c3a\u5bf8\u548c\u7d20\u6750\u6570\u91cf\u3002'],
    RH_AUTH_FAILED: [401, '\u63a5\u53e3\u8ba4\u8bc1\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5 API \u914d\u7f6e\u6216\u8054\u7cfb\u7ba1\u7406\u5458\u3002'],
    RH_PERMISSION_DENIED: [403, '\u5f53\u524d\u8bf7\u6c42\u65e0\u8bbf\u95ee\u6743\u9650\uff0c\u8bf7\u68c0\u67e5\u8d26\u6237\u548c\u6a21\u578b\u6743\u9650\u3002'],
    RH_QUOTA_EXHAUSTED: [402, '\u53ef\u7528\u989d\u5ea6\u4e0d\u8db3\uff0c\u8bf7\u68c0\u67e5\u8d26\u6237\u989d\u5ea6\u6216\u8054\u7cfb\u7ba1\u7406\u5458\u3002'],
    RH_RATE_LIMITED: [429, '\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002'],
    RH_MODEL_UNAVAILABLE: [503, '\u5f53\u524d\u6a21\u578b\u6682\u4e0d\u53ef\u7528\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u6216\u9009\u62e9\u5176\u4ed6\u6a21\u578b\u3002'],
    RH_CONTENT_REJECTED: [400, '\u63d0\u793a\u8bcd\u6216\u53c2\u8003\u7d20\u6750\u672a\u901a\u8fc7\u5185\u5bb9\u68c0\u67e5\uff0c\u8bf7\u8c03\u6574\u540e\u518d\u8bd5\u3002'],
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
const WRAPPERS = ['data', 'result', 'output', 'task', 'response', 'Response', 'base_resp'];
const FAILED = new Set(['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'expired']);
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
        || (error && typeof error === 'object' && !Array.isArray(error) && Boolean(error.message || error.msg || error.code || error.type));
    const hasFailureReason = ['failReason', 'fail_reason', 'failure_reason', 'error_message', 'errorMessage']
        .some(key => typeof value[key] === 'string' && value[key].trim());
    if (FAILED.has(state) || value.success === false || value.ok === false || value.type === 'error'
        || value.type === 'response.failed' || hasError || hasFailureReason
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
    for (const key of ['task_id', 'taskId', 'request_id', 'id', 'TaskId']) {
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
    const node = failureNode(value) || value;
    if (typeof node === 'string') return node.slice(0, 16384);
    if (!node || typeof node !== 'object') return '';
    const direct = ['error', 'Error', 'code', 'type', 'message', 'msg', 'description',
        'failReason', 'fail_reason', 'failure_reason', 'error_message', 'errorMessage', 'status_msg']
        .filter(key => own(node, key)).map(key => {
            const field = node[key];
            if (typeof field === 'string' || typeof field === 'number') return String(field);
            if (field && typeof field === 'object') return errorText(field, depth + 1);
            return '';
        }).join(' ');
    const nested = WRAPPERS.map(key => {
        const failed = failureNode(node[key]);
        return failed ? errorText(failed, depth + 1) : '';
    }).join(' ');
    return `${direct} ${nested}`.slice(0, 16384);
}

function classify(status, value, { query = false, terminal = false, transport = false } = {}) {
    const text = errorText(value);
    // An uncertain POST must never turn into an invitation to automatically resubmit.
    if (!query && !terminal && (transport || status === 408 || status >= 500)) return 'RH_SUBMISSION_UNKNOWN';
    if (/(?:只|仅)支持生成包含(?:您|你)自己(?:的|肖像|人脸)|仅支持(?:本人|自己)(?:的)?肖像|only\s+(?:supports?\s+)?(?:generat\w+\s+)?videos?\s+(?:of|featuring|containing)\s+(?:you\b|yourself\b)|only.{0,60}(?:your own likeness|your own face)/i.test(text)) return 'RH_PORTRAIT_SELF_REQUIRED';
    if (/肖像保护|人脸.{0,16}(?:保护|限制|不支持|禁止)|(?:portrait|likeness)\s+protection|(?:real(?:istic)?[ -]?(?:people|person|face)|human[ -]?faces?).{0,40}(?:not supported|not allowed|prohibited|restricted)/i.test(text)) return 'RH_PORTRAIT_RESTRICTED';
    if (/content[_ -]?(policy|filter)|safety|moderation|nsfw|\u5185\u5bb9\u5ba1\u6838|\u8fdd\u89c4/i.test(text)) return 'RH_CONTENT_REJECTED';
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
    const terminal = explicitFailure || code.startsWith('RH_PORTRAIT_');
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

// Clients rebuild the display from our catalogue instead of trusting echoed messages.
function readPublicError(payload) {
    const value = parsePayload(payload);
    const node = failureNode(value);
    const error = node?.error;
    if (error?.type !== 'ravenhash_error' || !Object.hasOwn(CATALOG, error.code)) return null;
    const requestId = /^rh_[a-f0-9]{32}$/.test(error.request_id || '') ? error.request_id : null;
    const confirmedFailure = isTerminalFailure(value) || error.code.startsWith('RH_PORTRAIT_');
    return { code: error.code, requestId, submissionUnknown: error.code === 'RH_SUBMISSION_UNKNOWN',
        taskId: findTaskId(value), confirmedFailure,
        retryable: !confirmedFailure && error.retryable === true,
        message: CATALOG[error.code][1] + (requestId ? `\n\u6392\u67e5\u7f16\u53f7\uff1a${requestId}` : '') };
}

function publicErrorResult(payload) {
    const error = readPublicError(payload);
    return error ? { success: false, error: error.message, code: error.code, requestId: error.requestId,
        submissionUnknown: error.submissionUnknown, retryable: error.retryable,
        taskId: error.taskId, confirmedFailure: error.confirmedFailure } : null;
}

function mapLocalError(status, payload, options = {}) {
    const mapped = readPublicError(payload);
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

module.exports = { CATALOG, parsePayload, failureNode, isTerminalFailure, safeTaskId, findTaskId,
    publicFailure, readPublicError, publicErrorResult, mapLocalError };
