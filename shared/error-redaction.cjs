'use strict';

/**
 * 面向用户的失败文案只允许出现「服务类别 + 排查编号」。
 *
 * 上游站点、路径、查询参数、渠道映射、鉴权头、账号池和供应商名称都不进入这一层。
 * 真实细节只写入本地诊断日志（electron-main/diagnostics.cjs 会再脱敏一次），
 * 排查时用 requestId / logId / 任务 ID 关联，而不是把上游原文回显给用户。
 *
 * 这里刻意只做纯字符串处理，没有任何 node 内建依赖，主进程与渲染进程可以共用同一份规则。
 */

// 服务类别取代具体 endpoint。用户需要知道「哪一类请求失败了」，不需要知道它打到哪个域名。
const SERVICE_LABELS = Object.freeze({
    image: '图片生成服务',
    video: '视频生成服务',
    text: '文字模型服务',
    vision: '视觉理解服务',
    upload: '素材上传服务',
    download: '生成产物服务',
    config: '配置服务',
    remote: '远程服务'
});

const GENERIC_SERVICE_LABEL = SERVICE_LABELS.remote;
const GENERIC_FAILURE_MESSAGE = '请求未能完成，请稍后重试。';
const REDACTED_DETAIL = '[已隐藏]';
const MAX_MESSAGE_LENGTH = 600;

function describeServiceRole(role) {
    const key = String(role || '').trim();
    return Object.hasOwn(SERVICE_LABELS, key) ? SERVICE_LABELS[key] : GENERIC_SERVICE_LABEL;
}

// 顺序有意义：先摘掉完整 URL 和凭据，再处理裸主机名，最后才收敏感词，
// 否则 URL 里的主机名会被前一条规则改写成不可再识别的形态。
const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s<>"'）），。；：、]+/gi;
const TOKEN_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}/g;
const ASSIGNED_SECRET_PATTERN =
    /((?:api[_-]?key|apikey|access[_-]?token|token|password|secret|authorization)\s*[=:]\s*["']?)[^\s,"';&}]+/gi;
const DATA_URI_PATTERN = /\bdata:[^;\s]+;base64,[A-Za-z0-9+/=]+/gi;
const IPV4_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;
// 用 TLD 白名单而不是「任意带点的词」，否则 sd2.5 / seedance_v2.5 / v1.6.0 这类型号也会被吃掉。
const HOSTNAME_PATTERN =
    /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|ai|asia|cn|co|dev|app|xyz|top|me|cc|tv|info|site|online|tech|cloud|run|sh|gg|link|pro|vip)\b(?::\d{1,5})?/gi;
// 中转架构与上游供应商标识：泄漏这些等于泄漏部署拓扑。
const INFRA_TERM_PATTERN =
    /(NewAPI|new-api|mj-api-secret|yamlrunner[_a-z]*|all_vendors_failed|unmarshal_response_body_failed|账号池|渠道映射|上游渠道|上游供应商|中转站)/gi;
// 机器可读负载：带引号键的对象，是上游原文最典型的形态。
const JSON_PAYLOAD_PATTERN = /\{[^{}]*"[^"]+"\s*:[^{}]*\}/g;

/**
 * 最后一道兜底清洗。用于「必须保留一句本地描述，但不能确定其中是否混入上游原文」的场合。
 * 它不能替代在源头改用 CATALOG 文案，只是防止新增调用点直接漏出去。
 */
function redactSensitiveText(value, options = {}) {
    const serviceLabel = describeServiceRole(options.role);
    const text = String(value ?? '');
    if (!text.trim()) return '';
    const cleaned = text
        .replace(DATA_URI_PATTERN, '[媒体内容已隐藏]')
        .replace(URL_PATTERN, serviceLabel)
        .replace(TOKEN_PATTERN, REDACTED_DETAIL)
        .replace(API_KEY_PATTERN, REDACTED_DETAIL)
        .replace(ASSIGNED_SECRET_PATTERN, `$1${REDACTED_DETAIL}`)
        .replace(JSON_PAYLOAD_PATTERN, REDACTED_DETAIL)
        .replace(IPV4_PATTERN, serviceLabel)
        .replace(HOSTNAME_PATTERN, serviceLabel)
        .replace(INFRA_TERM_PATTERN, serviceLabel)
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';
    return cleaned.length > MAX_MESSAGE_LENGTH ? `${cleaned.slice(0, MAX_MESSAGE_LENGTH)}…` : cleaned;
}

/** 排查编号后缀。用户拿编号找运营，运营在诊断日志里查真实上游细节。 */
function traceSuffix(...ids) {
    const trace = ids.map(id => String(id || '').trim()).find(Boolean);
    return trace && /^[A-Za-z0-9_:-]{1,80}$/.test(trace) ? `\n排查编号：${trace}` : '';
}

module.exports = {
    SERVICE_LABELS,
    GENERIC_SERVICE_LABEL,
    GENERIC_FAILURE_MESSAGE,
    describeServiceRole,
    redactSensitiveText,
    traceSuffix
};
