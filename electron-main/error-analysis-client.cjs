const { sanitizeCustomerMessage } = require('../shared/customer-error-message.cjs');

function createErrorAnalysisClient({ fetchImpl, now = Date.now } = {}) {
    const cache = new Map(), pending = new Map();
    return { async get(token) {
        if (!/^ea_[a-f0-9]{32}$/.test(token || '')) return { state: 'unavailable' };
        if (cache.has(token) && now() - cache.get(token).at < 30000) return cache.get(token).value;
        if (pending.has(token)) return pending.get(token);
        const request = (async () => {
            try {
                const response = await fetchImpl(`https://artconfig.ravenhash.org/error-analysis/${token}`, {
                    method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(8000) });
                if (!response.ok) throw new Error('Unavailable');
                const text = await response.text();
                if (text.length > 8000) throw new Error('Invalid result');
                const data = JSON.parse(text);
                let value = { state: data.state === 'pending' ? 'pending' : 'unavailable' };
                if (data.state === 'ready' && ['检查参考素材', '检查生成参数', '联系管理员核对', '稍后查询原任务'].includes(data.suggestion)
                    && typeof data.cause === 'string' && typeof data.evidence === 'string'
                    && data.cause.length <= 400 && data.evidence.length <= 600
                    && sanitizeCustomerMessage(data.cause).message === data.cause
                    && sanitizeCustomerMessage(data.evidence).message === data.evidence) {
                    value = { state: 'ready', cause: data.cause, evidence: data.evidence, suggestion: data.suggestion };
                }
                if (cache.size >= 200) cache.delete(cache.keys().next().value);
                cache.set(token, { at: now(), value }); return value;
            } catch { return { state: 'unavailable' }; }
            finally { pending.delete(token); }
        })();
        pending.set(token, request); return request;
    } };
}
module.exports = { createErrorAnalysisClient };
