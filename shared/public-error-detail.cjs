const CATEGORIES = new Set(['parameter', 'auth', 'permission', 'quota', 'rate_limit', 'model_unavailable', 'moderation', 'asset', 'service', 'unknown']);
const STAGES = new Set(['validate', 'upload', 'submit', 'poll', 'download']);
const SUBMISSION_STATES = new Set(['not_submitted', 'rejected', 'accepted', 'unknown']);
const ACTIONS = new Set(['edit_parameters', 'check_account', 'replace_reference', 'retry_query', 'contact_support', 'wait']);
const ISSUE_FIELDS = new Set(['duration', 'resolution', 'aspect_ratio', 'quality', 'n', 'referenceImages', 'referenceVideos', 'referenceAudios',
    'referenceImageBytes', 'referenceVideoBytes', 'referenceAudioBytes', 'referenceVideoDuration', 'referenceAudioDuration']);
const ISSUE_REASONS = new Set(['min', 'max', 'range', 'integer', 'unsupported', 'required', 'count', 'format', 'unreadable']);
const FIELD_ALIASES = Object.freeze({ image_count: 'referenceImages', video_count: 'referenceVideos', audio_count: 'referenceAudios',
    image_bytes: 'referenceImageBytes', video_bytes: 'referenceVideoBytes', audio_bytes: 'referenceAudioBytes',
    video_duration: 'referenceVideoDuration', audio_duration: 'referenceAudioDuration' });
const FIELD_LABELS = Object.freeze({ duration: '视频时长', resolution: '分辨率', aspect_ratio: '画面比例', quality: '画质', n: '生成数量',
    referenceImages: '参考图片数量', referenceVideos: '参考视频数量', referenceAudios: '参考音频数量',
    referenceImageBytes: '参考图片大小', referenceVideoBytes: '参考视频大小', referenceAudioBytes: '参考音频大小',
    referenceVideoDuration: '参考视频时长', referenceAudioDuration: '参考音频时长' });
const CATEGORY_MESSAGES = Object.freeze({ parameter: '生成参数不符合要求，请调整后重新提交。',
    auth: '接口认证失败，请检查 API 配置或联系管理员。', permission: '当前请求没有访问权限，请检查账户权限。',
    quota: '可用额度不足，请检查账户额度或联系管理员。', rate_limit: '请求过于频繁，请稍后再试。',
    model_unavailable: '当前模型暂不可用，请稍后再试或选择其他模型。', moderation: '内容审核未通过，请调整提示词或参考素材。',
    asset: '参考素材无法处理，请检查素材格式或重新上传。', service: '当前生成服务暂不可用，请稍后查询或联系管理员。',
    unknown: '请求未能完成，请根据排查编号联系管理员。' });
const LOCAL_CODES = new Set(['LOCAL_MODEL_PARAMETER_INVALID', 'LOCAL_MODEL_RULES_INVALID', 'LOCAL_MODEL_RULES_UNSUPPORTED']);
const LOCAL_RULE_MESSAGES = Object.freeze({
    LOCAL_MODEL_RULES_INVALID: '当前模型的参数配置无效，请联系管理员更新配置。',
    LOCAL_MODEL_RULES_UNSUPPORTED: '当前客户端不支持此模型的参数规则，请升级客户端后重试。'
});
const STATE_MESSAGES = Object.freeze({ not_submitted: '本次请求尚未提交。', rejected: '本次请求已被拒绝。',
    accepted: '任务已受理，请继续查询原任务，不要重复提交。', unknown: '暂时无法确认任务是否受理，请先查询原任务或联系管理员，不要重复提交。' });

function safeRequestId(value) {
    return typeof value === 'string' && /^(?:rh|fc)_[a-zA-Z0-9_-]{8,80}$/.test(value) ? value : null;
}

function safeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9
        ? Math.round(value * 1e6) / 1e6 : undefined;
}

function safeParameterValue(field, value) {
    const number = safeNumber(value);
    if (number !== undefined) return number;
    if (typeof value !== 'string') return undefined;
    if (field === 'resolution' && /^(?:[1-9]\d{1,3}p|[1-9]K)$/i.test(value)) return value.toLowerCase();
    if (field === 'aspect_ratio' && /^(?:[1-9]\d{0,2}:[1-9]\d{0,2}|adaptive)$/.test(value)) return value;
    if (field === 'quality' && ['low', 'medium', 'high', 'standard', 'hd', 'auto'].includes(value)) return value;
    return undefined;
}

// Free text never enters this contract, including model names and provider labels.
function normalizeParameterIssues(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 16).flatMap(raw => {
        if (!raw || typeof raw !== 'object') return [];
        const inputField = raw.field || raw.parameter;
        const issue = { ...raw, field: FIELD_ALIASES[inputField] || inputField,
            reason: ({ minimum: 'min', maximum: 'max', one_of: 'unsupported' })[raw.rule || raw.reason] || raw.rule || raw.reason };
        if (!ISSUE_FIELDS.has(issue.field) || !ISSUE_REASONS.has(issue.reason)) return [];
        const clean = { field: issue.field, reason: issue.reason };
        if (issue.integer === true) clean.integer = true;
        for (const key of ['min', 'max', 'actual', 'step']) {
            const number = safeNumber(issue[key]);
            if (number !== undefined) clean[key] = number;
        }
        const actual = safeParameterValue(issue.field, issue.actual);
        if (actual !== undefined) clean.actual = actual;
        const resolution = safeParameterValue('resolution', issue.resolution);
        if (typeof resolution === 'string') clean.resolution = resolution;
        if (Number.isInteger(issue.index) && issue.index >= 1 && issue.index <= 1000) clean.index = issue.index;
        if (Array.isArray(issue.allowed)) {
            const allowed = issue.allowed.slice(0, 32).map(entry => safeParameterValue(issue.field, entry)).filter(entry => entry !== undefined);
            if (allowed.length) clean.allowed = [...new Set(allowed)];
        }
        return [clean];
    });
}

function normalizePublicDetail(value) {
    if (!value || typeof value !== 'object' || (value.protocolVersion !== 2 && !LOCAL_CODES.has(value.code))) return null;
    const local = LOCAL_CODES.has(value.code);
    const category = CATEGORIES.has(value.category) ? value.category : local ? 'parameter' : 'unknown';
    const submissionState = local ? 'not_submitted'
        : SUBMISSION_STATES.has(value.submissionState) ? value.submissionState : 'unknown';
    const code = typeof value.code === 'string' && /^(?:RH|LOCAL)_[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : 'RH_UNKNOWN_ERROR';
    const clean = { protocolVersion: 2, code, category,
        stage: local ? 'validate' : STAGES.has(value.stage) ? value.stage : 'submit',
        submissionState, action: ACTIONS.has(value.action) ? value.action : local ? 'edit_parameters' : 'contact_support',
        billingState: 'unknown', parameterIssues: normalizeParameterIssues(value.parameterIssues),
        submissionUnknown: submissionState === 'unknown',
        retryable: !['not_submitted', 'rejected'].includes(submissionState) && value.retryable === true,
        confirmedFailure: submissionState === 'rejected' || (submissionState === 'accepted' && value.confirmedFailure === true) };
    const requestId = safeRequestId(value.requestId || value.request_id);
    if (requestId) clean.requestId = requestId;
    return clean;
}

function formatParameterIssue(raw) {
    const issue = normalizeParameterIssues([raw])[0];
    if (!issue) return '';
    const label = `${issue.resolution ? issue.resolution + ' ' : ''}${issue.index ? `第 ${issue.index} 项` : ''}${FIELD_LABELS[issue.field]}`;
    const unit = /[Dd]uration$/.test(issue.field) ? ' 秒' : /Bytes$/.test(issue.field) ? ' 字节' : '';
    let constraint;
    if (issue.reason === 'unreadable') constraint = '无法读取，请重新上传或更换素材';
    else if (issue.reason === 'required') constraint = '不能为空';
    else if (issue.max === 0) constraint = '不支持';
    else if (issue.min !== undefined && issue.max !== undefined) constraint = `应为 ${issue.min} 到 ${issue.max}${unit}`;
    else if (issue.max !== undefined) constraint = `最多 ${issue.max}${unit}`;
    else if (issue.min !== undefined) constraint = `至少 ${issue.min}${unit}`;
    else if (issue.allowed?.length) constraint = `仅支持 ${issue.allowed.join('、')}${unit}`;
    else if (issue.reason === 'format') constraint = '格式不支持，请转换格式后重新上传';
    else if (issue.reason === 'integer') constraint = '必须为整数';
    else constraint = '不符合当前模型要求';
    if (issue.integer && issue.reason !== 'integer') constraint += '，且必须为整数';
    const actual = issue.actual !== undefined ? `，当前为 ${issue.actual}${unit}` : '';
    return `${label}${constraint}${actual}。`;
}

function formatPublicDetail(value, catalog = {}) {
    const detail = normalizePublicDetail(value);
    if (!detail) return null;
    const issues = detail.parameterIssues.map(formatParameterIssue).filter(Boolean);
    const message = issues.length ? issues.join('\n') : LOCAL_RULE_MESSAGES[detail.code]
        || catalog[detail.code]?.[1] || CATEGORY_MESSAGES[detail.category];
    const state = detail.confirmedFailure && detail.submissionState === 'accepted'
        ? '原任务已失败，请调整后重新提交。' : STATE_MESSAGES[detail.submissionState];
    return `${message}\n${state}${detail.requestId ? `\n排查编号：${detail.requestId}` : ''}`;
}

// Recognize only our complete numeric grammar when legacy callers retain just the message.
function isFormattedPublicDetail(value, catalog = {}) {
    if (typeof value !== 'string') return false;
    const lines = value.split('\n');
    if (lines.length < 2 || lines.length > 18) return false;
    const constants = new Set([...Object.values(CATEGORY_MESSAGES), ...Object.values(LOCAL_RULE_MESSAGES),
        ...Object.values(STATE_MESSAGES), ...Object.values(catalog).map(entry => entry[1]), '原任务已失败，请调整后重新提交。']);
    const token = '(?:\\d+(?:\\.\\d+)?p?|[1-9]k|\\d+:\\d+|adaptive|low|medium|high|standard|hd|auto)';
    const parameter = new RegExp(`^(?:(?:[1-9]\\d{1,3}p|[1-9]k) )?(?:第 \\d{1,4} 项)?(?:视频时长|分辨率|画面比例|画质|生成数量|参考(?:图片|视频|音频)(?:数量|大小|时长))(?:无法读取，请重新上传或更换素材|不能为空|格式不支持，请转换格式后重新上传|不支持|应为 [\\d.]+ 到 [\\d.]+(?: 秒| 字节)?|最多 [\\d.]+(?: 秒| 字节)?|至少 [\\d.]+(?: 秒| 字节)?|仅支持 ${token}(?:、${token})*(?: 秒| 字节)?|必须为整数|不符合当前模型要求)(?:，且必须为整数)?(?:，当前为 ${token}(?: 秒| 字节)?)?。$`);
    return lines.some(line => Object.values(STATE_MESSAGES).includes(line) || line === '原任务已失败，请调整后重新提交。')
        && lines.every(line => constants.has(line) || parameter.test(line)
            || (line.startsWith('排查编号：') && safeRequestId(line.slice('排查编号：'.length))));
}

module.exports = { normalizeParameterIssues, normalizePublicDetail, safeRequestId,
    formatParameterIssue, formatPublicDetail, isFormattedPublicDetail, CATEGORY_MESSAGES, LOCAL_CODES };
