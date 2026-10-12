const crypto = require('node:crypto');

const failure = message => Object.assign(new Error(message), { publicMessage: message });
const validKey = value => typeof value === 'string' && /^sk-[A-Za-z0-9_-]{8,500}$/.test(value);

async function requestAccountJson(session, origin, auth, route, body) {
    let response;
    try {
        response = await session.fetch(origin + route, { method: body === undefined ? 'GET' : 'POST',
            redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { Authorization: `Bearer ${auth}`, Accept: 'application/json',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw failure('站点连接超时，请点击连接画布重试'); }
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401) throw Object.assign(failure('登录已过期，请在站点重新登录'), { code: 'RELAY_AUTH_EXPIRED' });
        if (response.status === 403) throw failure('当前账户没有连接权限，请检查站点账户状态');
        if (response.status === 429) throw failure('站点请求过于频繁，请稍后重试');
        throw failure('读取站点账户失败，请稍后重试');
    }
    const chunks = []; let size = 0;
    try {
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 1024 * 1024) throw new Error('Response too large');
            chunks.push(Buffer.from(chunk));
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response');
        return value;
    } catch { throw failure('站点账户响应不完整，请点击连接画布重试'); }
}

function accountRequest({ site, origin, session, auth }) {
    const request = async (route, body) => {
        const result = await requestAccountJson(session, origin, auth, route, body);
        if (site !== 'ai') return result;
        if (result.success !== true) throw failure('生图站认证未完成，请在站点完成登录后重试');
        return result.data;
    };
    return request;
}

function tokenState(site, token) {
    if (Number(site === 'ai' ? token.status : token.is_active) !== 1) return '已停用';
    if (site !== 'ai' && (Number(token.only_playground) === 1 || Number(token.only_playground_2026) === 1)) return '仅限网页';
    if (site === 'ai' && Number(token.expired_time) > 0 && token.expired_time * 1000 <= Date.now()) return '已过期';
    if (site !== 'ai' && token.expires_at) {
        const expires = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(token.expires_at)
            ? token.expires_at : token.expires_at.replace(' ', 'T') + 'Z');
        if (!Number.isFinite(expires) || expires <= Date.now()) return '已过期';
    }
    if (site !== 'ai' && !validKey(token.token_key)) return 'Key 不可读取';
    return '';
}

async function readRelayTokens(options) {
    const { site, stillCurrent } = options;
    const request = accountRequest(options);
    const profile = await request(site === 'ai' ? '/api/user/self' : '/api/v1/user/profile');
    const userId = typeof profile?.id === 'string' || Number.isSafeInteger(profile?.id) ? String(profile.id) : '';
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(userId) || Number(site === 'ai' ? profile.status : profile.is_active) !== 1) {
        throw failure('当前站点账户不可用，请重新登录');
    }
    const tokens = new Map();
    for (let page = 1; page <= 10; page++) {
        const data = await request(site === 'ai' ? `/api/token/?p=${page}&size=100` : `/api/v1/tokens?page=${page}&per_page=100`);
        const items = site === 'ai' ? (Array.isArray(data) ? data : data?.items) : data?.data;
        if (!Array.isArray(items)) throw failure('站点未返回有效的 API Key 列表');
        for (const token of items) {
            if (!Number.isSafeInteger(token?.id) || token.id < 1) continue;
            if (String(token.user_id) !== userId && !(site === 'ai' && token.user_id === undefined)) continue;
            tokens.set(String(token.id), token);
        }
        const total = Number(data?.total ?? data?.pagination?.total);
        if (items.length < 100 || (Number.isFinite(total) && total <= page * 100)) {
            if (!await stillCurrent()) throw failure('登录账户已变化，请重新连接');
            return { request, tokens, userId, username: String(profile.username || '').slice(0, 80) };
        }
    }
    throw failure('API Key 数量过多，请在站点整理后重试');
}

async function listRelayAccounts(options) {
    const { tokens, userId, username } = await readRelayTokens(options);
    return { site: options.site, userId, username, tokens: [...tokens.values()].map(token => {
        const secret = String(options.site === 'ai' ? token.key || '' : token.token_key || '');
        const reason = tokenState(options.site, token);
        return { id: String(token.id), name: String(token.name || `Key ${token.id}`).slice(0, 120),
            maskedKey: secret ? `sk-...${secret.slice(-4)}` : '', enabled: !reason, reason };
    }) };
}

async function resolveRelayAccounts(options, selection) {
    const ids = selection?.tokenIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
        throw failure('请选择需要导入的 API Key');
    }
    const { request, tokens, userId, username } = await readRelayTokens(options);
    if (userId !== selection.userId) throw failure('登录账户已变化，请重新选择 API Key');
    const accounts = [];
    for (const id of ids) {
        const token = tokens.get(id);
        if (!token || tokenState(options.site, token)) throw failure('所选 Key 已失效或不可用，请重新读取列表');
        if (!await options.stillCurrent()) throw failure('登录账户已变化，请重新连接');
        let apiKey = token.token_key;
        if (options.site === 'ai') {
            const secret = await request(`/api/token/${token.id}/key`, {});
            apiKey = typeof secret?.key === 'string' ? (secret.key.startsWith('sk-') ? secret.key : `sk-${secret.key}`) : '';
        }
        if (!validKey(apiKey)) throw failure('站点未返回所选 API Key 的完整值');
        accounts.push({ site: options.site, userId, username, tokenId: id, tokenName: String(token.name || '').slice(0, 120), apiKey });
    }
    const { stillCurrent } = options;
    if (!await stillCurrent()) throw failure('登录账户已变化，请重新连接');
    return accounts;
}

class RelayAccountDelivery {
    constructor({ timeout = 45000 } = {}) { this.pending = new Map(); this.timeout = timeout; }

    send(web, account) {
        return this.request(web, 'relay-account:connect', { account }, this.timeout);
    }

    select(web, catalog) {
        return this.request(web, 'relay-account:select', { catalog }, 0, true);
    }

    request(web, channel, payload, timeout, selection = false) {
        if (!web || web.isDestroyed()) return Promise.reject(failure('画布尚未就绪，请打开画布后重试'));
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const finish = (error, result) => {
                const pending = this.pending.get(id);
                if (!pending) return;
                clearTimeout(pending.timer); web.removeListener('destroyed', pending.closed);
                this.pending.delete(id);
                if (error) reject(error); else resolve(result);
            };
            const closed = () => finish(failure('画布已关闭，请重新连接'));
            const timer = timeout ? setTimeout(() => finish(failure('画布未确认保存，请点击连接画布重试')), timeout) : null;
            this.pending.set(id, { web, timer, closed, finish, selection });
            web.once('destroyed', closed);
            web.send(channel, { id, ...payload });
        });
    }

    complete(web, id, result) {
        const pending = this.pending.get(id);
        if (!pending || pending.web !== web) return false;
        if (pending.selection) {
            if (result?.canceled === true) pending.finish(null, null);
            else if (Array.isArray(result?.tokenIds) && result.tokenIds.length <= 100 && result.tokenIds.every(id => typeof id === 'string')) {
                pending.finish(null, result.tokenIds);
            } else pending.finish(failure('API Key 选择无效，请重试'));
        } else pending.finish(result?.success === true ? null : failure('API 配置未能保存，请检查画布配置和系统凭据服务后重试'));
        return true;
    }
}

module.exports = { requestAccountJson, listRelayAccounts, resolveRelayAccounts, RelayAccountDelivery };
