const crypto = require('node:crypto');

const TOKEN_NAME = 'Corvas Canvas';
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
        if (response.status === 401) throw failure('登录已过期，请在站点重新登录');
        if (response.status === 403) throw failure('当前账户没有连接权限，请检查站点账户状态');
        if (response.status === 429) throw failure('站点请求过于频繁，请稍后重试');
        throw failure(body ? '站点未能创建画布专用 Key，请检查账户绑定要求和密钥数量限制' : '读取站点账户失败，请稍后重试');
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

async function resolveRelayAccount({ site, origin, session, auth, getPrevious, stillCurrent, manual = false }) {
    if (site === 'ai') return resolveNewApiAccount({ site, origin, session, auth, getPrevious, stillCurrent, manual });
    const request = (route, body) => requestAccountJson(session, origin, auth, route, body);
    const profile = await request('/api/v1/user/profile');
    const userId = typeof profile.id === 'string' || Number.isSafeInteger(profile.id) ? String(profile.id) : '';
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(userId) || Number(profile.is_active) !== 1) {
        throw failure('当前站点账户不可用，请重新登录');
    }
    const previous = getPrevious?.(site, userId);
    const result = await request('/api/v1/tokens');
    if (!Array.isArray(result.data)) throw failure('站点未返回有效的 API Key 列表');
    const own = result.data.filter(token => String(token.user_id) === userId);
    let token = previous?.tokenId ? own.find(token => String(token.id) === String(previous.tokenId)) : null;
    token ||= own.filter(token => token.name === TOKEN_NAME).sort((a, b) => Number(a.id) - Number(b.id))[0];
    if (!token) {
        if (previous && !manual) throw failure('画布专用 Key 已被删除，点击连接画布可重新连接');
        if (!await stillCurrent()) throw failure('登录账户已变化，请重新连接');
        // A failed POST is never retried here. A manual retry lists tokens first.
        token = await request('/api/v1/tokens', { name: TOKEN_NAME });
    }
    if (String(token.user_id) !== userId || !Number.isSafeInteger(token.id) || token.id < 1) {
        throw failure('站点返回的 Key 与当前账户不一致');
    }
    if (Number(token.is_active) !== 1 || Number(token.only_playground) === 1 || Number(token.only_playground_2026) === 1) {
        throw failure('画布专用 Key 已停用或仅限网页使用，请在站点密钥管理中调整');
    }
    if (token.expires_at) {
        const expires = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(token.expires_at)
            ? token.expires_at : token.expires_at.replace(' ', 'T') + 'Z');
        if (!Number.isFinite(expires) || expires <= Date.now()) throw failure('画布专用 Key 已过期，请在站点密钥管理中调整');
    }
    if (!validKey(token.token_key)) throw failure('站点未返回可用的 API Key，请在站点密钥管理中检查');
    if (!await stillCurrent()) throw failure('登录账户已变化，请重新连接');
    return { site, userId, username: String(profile.username || '').slice(0, 80),
        tokenId: String(token.id), apiKey: token.token_key };
}

async function resolveNewApiAccount({ site, origin, session, auth, getPrevious, stillCurrent, manual }) {
    const request = async (route, body) => {
        const result = await requestAccountJson(session, origin, auth, route, body);
        if (result.success !== true) throw failure('生图站认证未完成，请在站点完成登录后重试');
        return result.data;
    };
    const profile = await request('/api/user/self');
    if (!Number.isSafeInteger(profile?.id) || profile.id < 1 || Number(profile.status) !== 1) {
        throw failure('生图站账户不可用，请重新登录');
    }
    const userId = String(profile.id), previous = getPrevious?.(site, userId);
    const list = async () => {
        const tokens = [];
        for (let page = 1; page <= 10; page++) {
            const data = await request(`/api/token/?p=${page}&size=100`);
            const items = Array.isArray(data) ? data : data?.items;
            if (!Array.isArray(items)) throw failure('生图站未返回有效的 Key 列表');
            tokens.push(...items.filter(token => token.user_id === undefined || String(token.user_id) === userId));
            if (items.length < 100 || Number(data?.total) <= page * 100) return tokens;
        }
        throw failure('生图站密钥数量过多，请在站点整理后重试');
    };
    const choose = tokens => (previous?.tokenId ? tokens.find(token => String(token.id) === previous.tokenId) : null)
        || tokens.filter(token => token.name === TOKEN_NAME).sort((a, b) => a.id - b.id)[0];
    let token = choose(await list());
    if (!token) {
        if (previous && !manual) throw failure('画布专用 Key 已被删除，点击连接画布可重新连接');
        if (!await stillCurrent()) throw failure('登录账户已变化，请重新连接');
        await request('/api/token/', { name: TOKEN_NAME, remain_quota: 0, unlimited_quota: true,
            expired_time: -1, model_limits_enabled: false, model_limits: '', allow_ips: '', group: '',
            auto_groups: [], cross_group_retry: false });
        token = choose(await list());
    }
    if (!token || !Number.isSafeInteger(token.id) || token.id < 1) throw failure('生图站未返回画布专用 Key，请重新连接');
    if (Number(token.status) !== 1 || (Number(token.expired_time) > 0 && token.expired_time * 1000 <= Date.now())) {
        throw failure('画布专用 Key 已停用或过期，请在生图站密钥管理中调整');
    }
    if (!await stillCurrent()) throw failure('登录账户已变化，请重新连接');
    const secret = await request(`/api/token/${token.id}/key`, {});
    const apiKey = typeof secret?.key === 'string' ? (secret.key.startsWith('sk-') ? secret.key : `sk-${secret.key}`) : '';
    if (!validKey(apiKey)) throw failure('生图站未返回可用的 API Key');
    if (!await stillCurrent()) throw failure('登录账户已变化，请重新连接');
    return { site, userId, username: String(profile.username || '').slice(0, 80), tokenId: String(token.id), apiKey };
}

class RelayAccountDelivery {
    constructor({ timeout = 45000 } = {}) { this.pending = new Map(); this.timeout = timeout; }

    send(web, account) {
        if (!web || web.isDestroyed()) return Promise.reject(failure('画布尚未就绪，请打开画布后重试'));
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const finish = error => {
                const pending = this.pending.get(id);
                if (!pending) return;
                clearTimeout(pending.timer); web.removeListener('destroyed', pending.closed);
                this.pending.delete(id);
                if (error) reject(error); else resolve();
            };
            const closed = () => finish(failure('画布已关闭，请重新连接'));
            const timer = setTimeout(() => finish(failure('画布未确认保存，请点击连接画布重试')), this.timeout);
            this.pending.set(id, { web, timer, closed, finish });
            web.once('destroyed', closed);
            web.send('relay-account:connect', { id, account });
        });
    }

    complete(web, id, result) {
        const pending = this.pending.get(id);
        if (!pending || pending.web !== web) return false;
        pending.finish(result?.success === true ? null : failure('API 配置未能保存，请检查画布配置和系统凭据服务后重试'));
        return true;
    }
}

module.exports = { TOKEN_NAME, requestAccountJson, resolveRelayAccount, RelayAccountDelivery };
