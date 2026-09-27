const PARAMETER_RULES_VERSION = 1;
const OPTION_FIELDS = ['resolutionTier', 'ratio', 'duration', 'quality', 'n'];
const REFERENCE_FIELDS = { referenceImages: 'image', referenceVideos: 'video', referenceAudios: 'audio' };
const SCALAR = value => (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000000)
    || (typeof value === 'string' && /^[A-Za-z0-9_.:+/-]{1,64}$/.test(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const clone = value => JSON.parse(JSON.stringify(value));
const numeric = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000000;
const displayValue = (field, value) => numeric(value)
    || (field === 'resolutionTier' && /^(?:[1-9][0-9]{2,3}p|[1248][kK])$/.test(String(value)))
    || (field === 'ratio' && /^(?:[1-9][0-9]?:[1-9][0-9]?|adaptive)$/.test(String(value)))
    || (field === 'quality' && ['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(value));
const normalizedFields = fields => ({ ...fields, resolutionTier: fields?.resolutionTier ?? fields?.resolution });

function validConstraint(option) {
    if (!only(option, ['type', 'values', 'value', 'min', 'max', 'integer', 'step', 'default', 'allowAuto'])) return false;
    if (option.default !== undefined && !SCALAR(option.default)) return false;
    if (option.allowAuto !== undefined && typeof option.allowAuto !== 'boolean') return false;
    if (option.type === 'enum') return Array.isArray(option.values) && option.values.length > 0
        && option.values.length <= 120 && option.values.every(SCALAR);
    if (option.type === 'fixed') return SCALAR(option.value);
    if (option.type !== 'range' || !numeric(option.min) || !numeric(option.max) || option.min > option.max) return false;
    if (option.integer !== undefined && typeof option.integer !== 'boolean') return false;
    if (option.step !== undefined && (!numeric(option.step) || option.step <= 0)) return false;
    return option.max - option.min <= 100000;
}

function validReference(capability) {
    return only(capability, ['supported', 'min', 'max', 'maxBytesPerImage']) && typeof capability.supported === 'boolean'
        && ['min', 'max', 'maxBytesPerImage'].every(key => capability[key] === undefined
            || (Number.isSafeInteger(capability[key]) && capability[key] >= 0 && capability[key] <= 1073741824))
        && !(capability.min !== undefined && capability.max !== undefined && capability.min > capability.max);
}

function validateParameterRules(parameterRules) {
    if (parameterRules === undefined) return [];
    if (object(parameterRules) && parameterRules.version !== PARAMETER_RULES_VERSION) {
        return [{ code: 'PARAMETER_RULES_UNSUPPORTED', field: 'model' }];
    }
    const valid = only(parameterRules, ['version', 'rules']) && parameterRules.version === PARAMETER_RULES_VERSION
        && Array.isArray(parameterRules.rules) && parameterRules.rules.length <= 64
        && parameterRules.rules.every(rule => only(rule, ['when', 'options', 'capabilities'])
            && only(rule.when, OPTION_FIELDS) && Object.keys(rule.when).length > 0
            && Object.values(rule.when).every(SCALAR)
            && (rule.options !== undefined || rule.capabilities !== undefined)
            && (rule.options === undefined || (only(rule.options, OPTION_FIELDS)
                && Object.keys(rule.options).length > 0 && Object.values(rule.options).every(validConstraint)
                && (rule.options.duration?.type !== 'range'
                    || (rule.options.duration.max - rule.options.duration.min) / (rule.options.duration.step || 1) < 10000)))
            && (rule.capabilities === undefined || (only(rule.capabilities, Object.keys(REFERENCE_FIELDS))
                && Object.keys(rule.capabilities).length > 0 && Object.values(rule.capabilities).every(validReference))));
    return valid ? [] : [{ code: 'PARAMETER_RULES_INVALID', field: 'model' }];
}

// Rules are ordered data patches: each matching rule replaces a complete constraint.
function resolveModelParameterRules(entry, fields = {}) {
    const issues = validateParameterRules(entry?.parameterRules);
    if (issues.length || !entry) return { entry, issues, appliedRules: [] };
    const resolved = { ...entry, options: clone(entry.options || {}), capabilities: clone(entry.capabilities || {}) };
    const values = normalizedFields(fields);
    const appliedRules = [];
    for (const [index, rule] of (entry.parameterRules?.rules || []).entries()) {
        if (!Object.entries(rule.when).every(([field, value]) => String(values[field]) === String(value))) continue;
        Object.assign(resolved.options, clone(rule.options || {}));
        Object.assign(resolved.capabilities, clone(rule.capabilities || {}));
        appliedRules.push(index);
    }
    return { entry: resolved, issues, appliedRules };
}

function constraintIssue(field, constraint, value) {
    if (!constraint || value === undefined || value === null || value === '') return null;
    const actual = numeric(Number(value)) ? Number(value) : undefined;
    if (constraint.type === 'range') {
        const number = Number(value);
        const stepped = constraint.step && Math.abs((number - constraint.min) / constraint.step - Math.round((number - constraint.min) / constraint.step)) > 1e-8;
        if (!Number.isFinite(number) || number < constraint.min || number > constraint.max
            || (constraint.integer && !Number.isInteger(number)) || stepped) {
            return { code: 'VALUE_OUT_OF_RANGE', field, min: constraint.min, max: constraint.max,
                integer: constraint.integer === true, ...(constraint.step ? { step: constraint.step } : {}),
                suggestion: Math.min(constraint.max, Math.max(constraint.min, Number.isFinite(number) ? number : constraint.min)),
                ...(actual !== undefined ? { actual } : {}) };
        }
    } else if (constraint.type === 'fixed' && String(constraint.value) !== String(value)) {
        return { code: 'VALUE_MUST_BE', field, ...(SCALAR(constraint.value) ? { expected: constraint.value, suggestion: constraint.value } : {}) };
    } else if (['enum', 'tier'].includes(constraint.type)) {
        if (constraint.allowAuto && ['-1', 'auto', 'adaptive'].includes(String(value))) return null;
        if (!(constraint.values || []).some(candidate => String(candidate) === String(value))) {
            return { code: 'VALUE_NOT_ALLOWED', field, allowed: (constraint.values || []).filter(SCALAR).slice(0, 120),
                suggestion: constraint.values?.[0] };
        }
    } else if (constraint.type === 'unsupported') return { code: 'PARAM_UNSUPPORTED', field };
    return null;
}

function validateModelParameterRequest(entry, fields = {}, references = {}) {
    const resolved = resolveModelParameterRules(entry, fields);
    const issues = [...resolved.issues];
    if (issues.length) return { ...resolved, ok: false, issues };
    for (const field of OPTION_FIELDS) {
        const issue = constraintIssue(field, resolved.entry?.options?.[field], normalizedFields(fields)[field]);
        if (issue) issues.push(issue);
    }
    for (const [field, kind] of Object.entries(REFERENCE_FIELDS)) {
        const input = references[kind];
        const count = Number(object(input) ? input.count : input) || 0;
        const capability = resolved.entry?.capabilities?.[field];
        if (capability?.supported === false && count > 0) issues.push({ code: 'FEATURE_UNSUPPORTED', field, max: 0, actual: count });
        else if (Number.isFinite(capability?.max) && count > capability.max) issues.push({ code: 'REFERENCE_LIMIT', field, max: capability.max, actual: count });
        else if (Number.isFinite(capability?.min) && count < capability.min) issues.push({ code: 'REFERENCE_REQUIRED', field, min: capability.min, actual: count });
        if (Number.isFinite(capability?.maxBytesPerImage) && Number(input?.maxBytes) > capability.maxBytesPerImage) {
            issues.push({ code: 'REFERENCE_TOO_LARGE', field, max: capability.maxBytesPerImage });
        }
    }
    return { ...resolved, ok: issues.length === 0, issues };
}

const FIELD_LABELS = { duration: '\u65f6\u957f', resolutionTier: '\u5206\u8fa8\u7387', ratio: '\u753b\u9762\u6bd4\u4f8b',
    quality: '\u753b\u8d28', n: '\u751f\u6210\u6570\u91cf', prompt: '\u63d0\u793a\u8bcd', referenceImages: '\u56fe\u7247\u53c2\u8003',
    referenceVideos: '\u89c6\u9891\u53c2\u8003', referenceAudios: '\u97f3\u9891\u53c2\u8003' };

function formatParameterIssue(issue = {}) {
    const label = FIELD_LABELS[issue.field] || '\u53c2\u6570';
    if (issue.code === 'PROMPT_REQUIRED') return '\u8bf7\u586b\u5199\u63d0\u793a\u8bcd\u3002';
    if (issue.code === 'PROMPT_TOO_LONG' && numeric(issue.max)) return `\u63d0\u793a\u8bcd\u6700\u591a ${issue.max} \u5b57\u3002`;
    if (issue.code === 'PARAMETER_RULES_UNSUPPORTED') return '\u5f53\u524d\u6a21\u578b\u7684\u53c2\u6570\u89c4\u5219\u9700\u8981\u66f4\u65b0\u5ba2\u6237\u7aef\u540e\u4f7f\u7528\u3002';
    if (issue.code === 'PARAMETER_RULES_INVALID') return '\u5f53\u524d\u6a21\u578b\u53c2\u6570\u914d\u7f6e\u5f02\u5e38\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458\u3002';
    if (issue.code === 'VALUE_OUT_OF_RANGE' && numeric(issue.min) && numeric(issue.max)) return `${label}\u9700\u8981\u5728 ${issue.min} \u5230 ${issue.max} ${issue.field === 'duration' ? '\u79d2' : '\u4e4b\u95f4'}${issue.integer ? '\uff0c\u4e14\u4e3a\u6574\u6570' : ''}${numeric(issue.actual) ? `\uff08\u5f53\u524d ${issue.actual}\uff09` : ''}\u3002`;
    if (issue.code === 'VALUE_MUST_BE' && displayValue(issue.field, issue.expected)) return `${label}\u56fa\u5b9a\u4e3a ${issue.expected}\u3002`;
    if (issue.code === 'VALUE_NOT_ALLOWED' && Array.isArray(issue.allowed) && issue.allowed.some(value => displayValue(issue.field, value))) return `${label}\u4ec5\u652f\u6301 ${issue.allowed.filter(value => displayValue(issue.field, value)).join(' / ')}\u3002`;
    if (issue.code === 'REFERENCE_LIMIT' && numeric(issue.max)) return `${label}\u6700\u591a ${issue.max} \u4e2a${numeric(issue.actual) ? `\uff0c\u5f53\u524d ${issue.actual} \u4e2a` : ''}\u3002`;
    if (issue.code === 'REFERENCE_REQUIRED' && numeric(issue.min)) return `${label}\u81f3\u5c11\u9700\u8981 ${issue.min} \u4e2a\u3002`;
    if (issue.code === 'REFERENCE_TOO_LARGE' && numeric(issue.max)) return `${label}\u6587\u4ef6\u8d85\u51fa\u5927\u5c0f\u9650\u5236\u3002`;
    if (['FEATURE_UNSUPPORTED', 'PARAM_UNSUPPORTED'].includes(issue.code)) return `\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301${label}\u3002`;
    return `${label}\u4e0d\u7b26\u5408\u5f53\u524d\u6a21\u578b\u7684\u8981\u6c42\uff0c\u8bf7\u8c03\u6574\u540e\u91cd\u8bd5\u3002`;
}

function createParameterValidationError(issues) {
    const issue = issues?.[0] || { code: 'VALUE_NOT_ALLOWED', field: 'model' };
    const parameterIssues = (issues || []).map(item => ({
        parameter: item.code === 'REFERENCE_TOO_LARGE'
            ? { referenceImages: 'referenceImageBytes', referenceVideos: 'referenceVideoBytes', referenceAudios: 'referenceAudioBytes' }[item.field]
            : { resolutionTier: 'resolution', ratio: 'aspect_ratio' }[item.field] || item.field,
        reason: { VALUE_OUT_OF_RANGE: 'range', VALUE_MUST_BE: 'range', VALUE_NOT_ALLOWED: 'format',
            FEATURE_UNSUPPORTED: 'unsupported', PARAM_UNSUPPORTED: 'unsupported', REFERENCE_LIMIT: 'maximum',
            REFERENCE_REQUIRED: 'minimum', REFERENCE_TOO_LARGE: 'maximum',
            PROMPT_REQUIRED: 'required', PROMPT_TOO_LONG: 'maximum' }[item.code] || 'format',
        ...(numeric(item.actual) ? { actual: item.actual } : {}),
        ...(numeric(item.min) ? { min: item.min } : {}),
        ...(numeric(item.max) ? { max: item.max } : {}),
        ...(item.integer === true ? { integer: true } : {}),
        ...(numeric(item.step) ? { step: item.step } : {}),
        ...(Array.isArray(item.allowed) ? { allowed: item.allowed.filter(value => displayValue(item.field, value)) } : {}),
        ...(item.code === 'VALUE_MUST_BE' && numeric(item.expected) ? { min: item.expected, max: item.expected } : {})
    }));
    return Object.assign(new Error(formatParameterIssue(issue)), {
        code: issue.code === 'PARAMETER_RULES_INVALID' ? 'LOCAL_MODEL_RULES_INVALID'
            : issue.code === 'PARAMETER_RULES_UNSUPPORTED' ? 'LOCAL_MODEL_RULES_UNSUPPORTED' : 'LOCAL_MODEL_PARAMETER_INVALID',
        protocolVersion: 2, category: 'parameter', stage: 'validate', submissionState: 'not_submitted',
        billingState: 'unknown', action: 'edit_parameters', parameterIssues, retryable: false, issues
    });
}

module.exports = { PARAMETER_RULES_VERSION, validateParameterRules, resolveModelParameterRules,
    validateModelParameterRequest, constraintIssue, formatParameterIssue, createParameterValidationError };
