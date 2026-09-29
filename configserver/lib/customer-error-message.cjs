// Pure, bounded text handling shared by the gateway, desktop main process and renderer.
const MAX_INPUT = 16384;
const MAX_MESSAGE = 1200;
const WRAPPERS = ['error', 'Error', 'errors', 'data', 'result', 'output', 'task', 'response', 'Response', 'base_resp', 'baseResp', 'metadata'];
const REASONS = ['message', 'msg', 'detail', 'description', 'reason', 'failReason', 'fail_reason', 'failure_reason', 'error_message', 'errorMessage', 'status_msg'];
const DEFAULT_TERMS = ['NewAPI', 'new-api', 'yamlrunner', 'GlobalAiOpc', 'StarFrame', 'Dreamina', 'TokensByte', 'shanhai', 'vnshu', 'xzapi', 'yueqi', 'zhubo'];

function extractErrorReasons(payload) {
    const parts = [], seen = new Set();
    let visits = 0;
    function visit(value, path, depth) {
        if (++visits > 120 || depth > 7) return;
        if (typeof value === 'string') {
            const text = value.slice(0, MAX_INPUT).trim();
            if (!text) return;
            try {
                const decoded = JSON.parse(text);
                if (decoded && typeof decoded === 'object') { visit(decoded, path, depth + 1); return; }
            } catch { /* A normal error sentence is not JSON. */ }
            if (!seen.has(text)) { seen.add(text); parts.push({ path, text }); }
        } else if (Array.isArray(value)) value.slice(0, 8).forEach((item, i) => visit(item, `${path}[${i}]`, depth + 1));
        else if (value && typeof value === 'object') {
            for (const key of REASONS) if (typeof value[key] === 'string') visit(value[key], `${path}.${key}`, depth + 1);
            for (const key of WRAPPERS) if (value[key]) visit(value[key], `${path}.${key}`, depth + 1);
        }
    }
    visit(payload, '$', 0);
    return parts.slice(0, 8);
}

function sanitizeCustomerMessage(value, { privateTerms = [], prompts = [] } = {}) {
    const hits = new Set();
    let text = typeof value === 'string' ? value.slice(0, MAX_INPUT).normalize('NFKC') : '';
    const replace = (pattern, replacement, label) => {
        text = text.replace(pattern, (...args) => { hits.add(label); return typeof replacement === 'function' ? replacement(...args) : replacement; });
    };
    replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '', 'control');
    for (const secret of [...prompts, ...DEFAULT_TERMS, ...privateTerms].filter(item => typeof item === 'string' && item.length >= 3).slice(0, 300)) {
        if (text.toLowerCase().includes(secret.toLowerCase())) {
            hits.add(prompts.includes(secret) ? 'input_content' : 'provider');
            text = text.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[已隐藏]');
        }
    }
    replace(/\b(?:https?|wss?|ftp):(?:\/\/|\\\/\\\/)[^\s<>"'）)，。；、]+/gi, '[地址已隐藏]', 'url');
    replace(/\b(?:Bearer|Basic)\s+[^\s,;"'}]+/gi, '[凭据已隐藏]', 'credential');
    replace(/\b(?:sk-|oc_live_|ghp_|gho_)[A-Za-z0-9_-]+/gi, '[凭据已隐藏]', 'credential');
    replace(/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|password|authorization|cookie|signature)\s*[=:]\s*["']?[^\s,;"'}]+/gi, '[凭据已隐藏]', 'credential');
    replace(/\bdata:[^\s"']+/gi, '[内容已隐藏]', 'media');
    replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[账号已隐藏]', 'account');
    replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '[地址已隐藏]', 'address');
    replace(/\[[a-f0-9:]*:[a-f0-9:]+\](?::\d+)?/gi, '[地址已隐藏]', 'address');
    replace(/(?<![\w:])(?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}(?![\w:])/gi, '[地址已隐藏]', 'address');
    replace(/\b(?:[a-z0-9][a-z0-9-]*\.)+[a-z][a-z0-9-]{1,62}\b(?:[/:?#][^\s<>"'）)，。；、]*)?/gi, '[地址已隐藏]', 'hostname');
    replace(/(?:[A-Z]:[\\/]|\/(?:opt|srv|home|root|var|etc|tmp|usr)\/)[^\s"'）)，。；]+/gi, '[路径已隐藏]', 'path');
    replace(/(?:\b(?:provider|supplier|vendor|channel|account|upstream[_ -]?model|channel_id|user_id|pool)\s*[=:]\s*["']?[^\s,;"'}]+|(?:供应商|渠道|上游模型|账号池|账户ID|用户ID)\s*[:：=]\s*[^\s，,；;。]+)/gi, '[服务信息已隐藏]', 'provider');
    replace(/\b(?:private|internal)[ -](?:supplier|provider|vendor)\b|\b(?:Provider|Supplier|Vendor)\s+[A-Z][\w-]*(?=\s|[;,:.]|$)/g, '[服务信息已隐藏]', 'provider');
    // Monetary clauses are removed as a whole so upstream balances cannot look like customer recharge instructions.
    text = text.split(/(?<=[。；;\n，])|(?<=,)(?!\d)/).map(clause => {
        if (/(?:[$¥€£]\s*\d|\d(?:[\d.,]*\d)?\s*(?:元|美元|人民币|美金|USD|CNY|RMB|USDT|credits?\b)|\b(?:USD|CNY|RMB|USDT)\s*[:=]?\s*\d|\b(?:prices?|costs?|balance|billing|quota|credits?|recharge)\b|价格|单价|售价|成本|余额|额度|扣费|计费|充值)/i.test(clause)) {
            hits.add('financial'); return '';
        }
        if (/(?:prompt|negative_prompt|messages|request_body|request_content|image_urls?|video_urls?|audio_urls?)\s*[:=]|提示词\s*[:：]|参考素材地址/i.test(clause)) {
            hits.add('input_content'); return '';
        }
        if (/\b(?:supplier|vendor|upstream)\b|供应商|上游渠道|账号池/i.test(clause)) {
            hits.add('provider'); return '';
        }
        if (/\bat\s+\S+\s*\([^)]*:\d+:\d+\)|Traceback|<!doctype|<html|<script/i.test(clause)) {
            hits.add('machine_payload'); return '';
        }
        return clause;
    }).join('');
    replace(/[A-Za-z0-9_+/=-]{48,}/g, '[内容已隐藏]', 'encoded');
    if (/[{}]|<\/?[a-z!][^>]*>|\\u[0-9a-f]{4}|%[0-9a-f]{2}/i.test(text)) { hits.add('machine_payload'); text = ''; }
    text = text.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
    const meaningful = text.replace(/\[[^\]]*已隐藏\]/g, '').replace(/HTTP\s*\d{3}|error|failed|failure|upstream|request|message|code/gi, '').replace(/[\s\d\W_]+/g, '');
    // Chinese punctuation is non-ASCII too, so check words explicitly rather than relying on \w.
    if (!/[\u3400-\u9fff]{2}|[a-z]{3}/i.test(text.replace(/\[[^\]]*已隐藏\]/g, '')) || (!meaningful && !/[\u3400-\u9fff]/.test(text))) text = '';
    if (/^(?:(?:task|request|generation)[_ ]?)?(?:failed|failure|error)[.!]?$/i.test(text)
        || /^(?:请求失败|任务失败|生成失败|服务异常)[。！!]?$/u.test(text)) text = '';
    return { message: text, rules: [...hits] };
}

function prepareCustomerMessage(payload, options = {}) {
    const parts = extractErrorReasons(payload);
    const sanitized = sanitizeCustomerMessage(parts.map(item => item.text).join('\n'), options);
    const message = options.suppress ? '' : sanitized.message;
    return { message, audit: { version: 1, sourceFields: parts.map(item => item.path),
        rules: [...sanitized.rules, ...(options.suppress ? ['service_account_or_unknown_submission'] : [])],
        outcome: message ? (sanitized.rules.length ? 'redacted' : 'preserved') : 'fallback',
        needsReview: !message && !options.suppress } };
}

module.exports = { extractErrorReasons, sanitizeCustomerMessage, prepareCustomerMessage };
