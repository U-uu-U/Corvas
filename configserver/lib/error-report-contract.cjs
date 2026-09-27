const MAX_ERROR_REPORT_BYTES = 2 * 1024 * 1024;
const REQUEST_ID = /^(?:rh|fc)_[A-Za-z0-9_-]{8,80}$/;
const SUBMISSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SECRET_FIELDS = new Set(['apikey', 'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password',
    'secret', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'signature', 'privatekey', 'env',
    'prompt', 'negativeprompt', 'userprompt', 'requestprompt', 'agentcompiledprompt', 'messages', 'content',
    'buffer', 'b64json', 'base64', 'sourcepaths', 'videosourcepaths', 'audiosourcepaths', 'filepath', 'filepaths',
    'imageurls', 'imageurl', 'videourls', 'videourl', 'audiourls', 'audiourl', 'referenceurls', 'referenceurl',
    'requestbody', 'requestdata', 'requestpayload']);

function classifyErrorReportSite(endpoint) {
    try {
        const host = new globalThis.URL(String(endpoint || '')).hostname.toLowerCase();
        return host === 'art.ravenhash.org' ? 'art' : host === 'cart.ravenhash.org' ? 'cart' : 'unknown';
    } catch { return 'unknown'; }
}

function sanitizeErrorReport(value, secrets = [], seen = new WeakSet(), depth = 0) {
    if (depth > 14) return '[depth limit]';
    if (typeof value === 'string') {
        let text = value.slice(0, 32768);
        for (const secret of secrets) {
            if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[credential omitted]');
        }
        // Serialized error envelopes must receive the same key filtering as objects.
        if (/^\s*[{[]/.test(text)) {
            try {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') return sanitizeErrorReport(parsed, secrets, seen, depth + 1);
            } catch { /* Preserve non-JSON stack traces and error messages. */ }
        }
        // Providers often prefix their serialized JSON with a transport error message.
        const start = text.search(/[{[]/);
        const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
        let parsedEnvelope = false;
        if (start >= 0 && end > start) {
            try {
                const parsed = JSON.parse(text.slice(start, end + 1));
                text = text.slice(0, start) + JSON.stringify(sanitizeErrorReport(parsed, secrets, seen, depth + 1)) + text.slice(end + 1);
                parsedEnvelope = true;
            } catch { /* Truncated or concatenated private envelopes are omitted below. */ }
        }
        if (!parsedEnvelope) text = text.split('\n').map(line => {
            const privateKey = [...line.matchAll(/["']([^"']+)["']\s*:/g)]
                .some(match => SECRET_FIELDS.has(match[1].toLowerCase().replace(/[^a-z0-9]/g, '')));
            return privateKey ? '[embedded private payload omitted]' : line;
        }).join('\n');
        return text
            .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'}]+/gi, '[credential omitted]')
            .replace(/\b(?:sk-|oc_live_|ghp_|gho_)[A-Za-z0-9_-]+/g, '[credential omitted]')
            .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization|signature)["']?\s*[=:]\s*["']?)[^\s,"';&}]+/gi, '$1[credential omitted]')
            .replace(/"(?:prompt|negative_prompt|messages|image_urls?|video_urls?|audio_urls?)"\s*:\s*"(?:\\.|[^"\\])*(?:"|$)/gi, '"private_input":"[omitted]"')
            .replace(/\b(?:prompt|negative_prompt)\s*[=:]\s*[^\r\n]+/gi, '[prompt omitted]')
            .replace(/data:[^\s"']+/gi, '[media omitted]')
            .replace(/https?:\/\/[^\s<>"'（）），。；：、]+/gi, url => {
                try { return `${new globalThis.URL(url).origin}/[path omitted]`; } catch { return '[url omitted]'; }
            })
            .replace(/[A-Za-z0-9+/=]{256,}/g, '[encoded data omitted]')
            .slice(0, 32768);
    }
    if (value instanceof Error) return sanitizeErrorReport({ name: value.name, message: value.message, stack: value.stack,
        code: value.code, requestId: value.requestId, taskId: value.taskId, stage: value.stage }, secrets, seen, depth + 1);
    if (!value || typeof value !== 'object') return typeof value === 'number' && !Number.isFinite(value) ? null : value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    let clean;
    if (Array.isArray(value)) clean = value.slice(0, 2000).map(entry => sanitizeErrorReport(entry, secrets, seen, depth + 1));
    else clean = Object.fromEntries(Object.entries(value).slice(0, 200).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key))
        .map(([key, entry]) => [key, SECRET_FIELDS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
            ? '[omitted]' : sanitizeErrorReport(entry, secrets, seen, depth + 1)]));
    seen.delete(value);
    return clean;
}

function normalizeErrorSubmission(input) {
    const invalid = () => { throw Object.assign(new Error('Invalid error report'), { code: 'INVALID_ERROR_REPORT', status: 400 }); };
    if (!input || typeof input !== 'object' || input.formatVersion !== 1 || !SUBMISSION_ID.test(input.submissionId || '')) invalid();
    const diagnostic = input.diagnostic;
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)
        || !Array.isArray(diagnostic.events) || !Array.isArray(diagnostic.tasks)) invalid();
    if (!['art', 'cart', 'unknown'].includes(input.site || 'unknown')) invalid();
    if (input.requestId && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(input.requestId))) invalid();
    const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
    const context = input.context && typeof input.context === 'object' && !Array.isArray(input.context) ? input.context : {};
    const clientContext = Object.fromEntries(['requestId', 'taskId', 'clientTaskId', 'projectId', 'nodeId', 'model', 'kind',
        'error', 'errorCode', 'code', 'stage', 'category', 'submissionState', 'parameterIssues', 'createdAt', 'updatedAt',
        'params', 'referenceCounts', 'providerId', 'site', 'configRevision', 'time', 'event', 'status', 'httpStatus',
        'attempts', 'retryable', 'confirmedFailure', 'submissionUnknown'].filter(key => Object.hasOwn(context, key)).map(key => [key, context[key]]));
    if (input.requestId && !clientContext.requestId) clientContext.requestId = input.requestId;
    const report = sanitizeErrorReport({ formatVersion: 1, submissionId: input.submissionId.toLowerCase(),
        description: text(input.description, 8000), contact: text(input.contact, 300), site: input.site || 'unknown',
        requestId: REQUEST_ID.test(input.requestId || '') ? input.requestId : (REQUEST_ID.test(context.requestId || '') ? context.requestId : ''),
        context: clientContext,
        diagnostic: { formatVersion: diagnostic.formatVersion || 1, exportedAt: diagnostic.exportedAt,
            sessionId: diagnostic.sessionId, environment: diagnostic.environment || {},
            droppedEvents: diagnostic.droppedEvents || 0, writeError: diagnostic.writeError || null,
            config: diagnostic.config, tasks: diagnostic.tasks.slice(0, 200), events: diagnostic.events.slice(-1500),
            completeness: { ...(diagnostic.completeness || {}),
                eventsSupplied: diagnostic.events.length, eventsIncluded: Math.min(1500, diagnostic.events.length),
                tasksSupplied: diagnostic.tasks.length, tasksIncluded: Math.min(200, diagnostic.tasks.length) } } });
    for (const key of ['description', 'contact']) {
        if (typeof report[key] !== 'string') report[key] = JSON.stringify(report[key]);
    }
    if (new globalThis.TextEncoder().encode(JSON.stringify(report)).length > MAX_ERROR_REPORT_BYTES) {
        throw Object.assign(new Error('Error report exceeds size limit'), { code: 'ERROR_REPORT_TOO_LARGE', status: 413 });
    }
    return report;
}

module.exports = { MAX_ERROR_REPORT_BYTES, REQUEST_ID, SUBMISSION_ID, normalizeErrorSubmission,
    sanitizeErrorReport, classifyErrorReportSite };
