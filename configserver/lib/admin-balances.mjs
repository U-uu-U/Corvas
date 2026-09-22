import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CACHE_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const ZHUBO_URL = 'https://video.zhubo.asia/v1/billing/balance';

export function createAdminBalances({ dataDir, seedPath, fetchImpl = fetch, now = Date.now }) {
    const accountsPath = path.join(dataDir, 'admin-balance-accounts.json');
    const privatePath = path.join(dataDir, 'admin-balance-credentials.json');
    const settingsPath = path.join(dataDir, 'admin-balance-settings.json');
    const cache = new Map();
    const pending = new Map();
    const read = (file, fallback) => {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('余额配置读取失败'); }
    };
    const accounts = () => {
        const config = read(accountsPath, null) || read(seedPath, { accounts: [] });
        if (!Array.isArray(config.accounts)) throw new Error('余额账户配置无效');
        return config.accounts;
    };
    function safeUrl(value) {
        try {
            const url = new URL(value);
            if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return value;
        } catch { /* Unverified links are omitted. */ }
        return '';
    }
    async function query(account, credential, force) {
        const old = cache.get(account.id);
        const age = now() - (old?.attemptedAt ?? -Infinity);
        if (old && age < (force || old.error ? RETRY_MS : CACHE_MS)) return old;
        if (pending.has(account.id)) return pending.get(account.id);
        const work = (async () => {
            let result;
            try {
                const response = await fetchImpl(ZHUBO_URL, { headers: { Authorization: `Bearer ${credential.key}`, Accept: 'application/json' },
                    redirect: 'error', signal: AbortSignal.timeout(8000) });
                if (!response.ok) throw new Error([401, 403].includes(response.status) ? '查询授权已失效' : '上游暂时无法查询');
                const body = await response.json();
                if (body.billing !== true || typeof body.balance !== 'number' || !Number.isFinite(body.balance)) {
                    throw new Error('上游未返回有效可用余额');
                }
                result = { amount: body.balance, updatedAt: new Date(now()).toISOString(), error: '' };
            } catch (error) {
                const known = ['查询授权已失效', '上游暂时无法查询', '上游未返回有效可用余额'];
                result = { amount: old?.amount ?? null, updatedAt: old?.updatedAt || null,
                    error: known.includes(error.message) ? error.message : '余额查询失败，请稍后刷新' };
            }
            result.attemptedAt = now();
            cache.set(account.id, result);
            return result;
        })();
        pending.set(account.id, work);
        try { return await work; } finally { pending.delete(account.id); }
    }
    async function list({ force = false } = {}) {
        const credentials = read(privatePath, {});
        const thresholds = read(settingsPath, {});
        const rows = await Promise.all(accounts().map(async account => {
            const threshold = Object.hasOwn(thresholds, account.id) ? thresholds[account.id] : account.threshold ?? null;
            const supported = account.provider === 'zhubo';
            const row = { id: account.id, name: account.name, account: account.account, url: safeUrl(account.url),
                currency: account.currency || null, threshold, editable: supported,
                amount: null, updatedAt: null, low: false, scope: supported ? '账户 / Token 可用余额' : '',
                status: 'unavailable', detail: account.reason || '待配置查询授权' };
            const credential = credentials[account.id];
            if (!supported || typeof credential?.key !== 'string' || !credential.key.trim()) return row;
            const identity = crypto.createHash('sha256').update(credential.key).digest('hex');
            const cacheId = `${account.id}:${identity}`;
            const result = await query({ ...account, id: cacheId }, credential, force);
            return { ...row, amount: result.amount, updatedAt: result.updatedAt,
                low: Number.isFinite(threshold) && result.amount !== null && result.amount < threshold,
                status: result.error ? result.amount === null ? 'error' : 'stale' : 'ok', detail: result.error };
        }));
        return { accounts: rows, refreshIntervalMs: CACHE_MS };
    }
    function setThreshold(id, value) {
        if (!accounts().some(account => account.id === id && account.provider === 'zhubo')) throw new Error('账户不支持余额阈值');
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000)) {
            throw new Error('预警线需要 0 到 1000000 的金额，或留空关闭');
        }
        const settings = read(settingsPath, {});
        const next = { ...settings, [id]: value };
        const temporary = settingsPath + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temporary, settingsPath);
        return { success: true };
    }
    return { list, setThreshold };
}
