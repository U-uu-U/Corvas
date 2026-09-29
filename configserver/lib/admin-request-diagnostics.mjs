import fs from 'node:fs';
import path from 'node:path';

const HOSTS = { art: 'art.ravenhash.org', cart: 'cart.ravenhash.org' };
const REQUEST_ID = /^(?:rh|fc)_[a-f0-9]{32}$/;

export function createAdminRequestDiagnostics({ dataDir, fetchImpl = fetch } = {}) {
    return {
        async get(site, requestId, { review = false } = {}) {
            if (!Object.hasOwn(HOSTS, site) || (!review && !REQUEST_ID.test(requestId || ''))) {
                return { status: 400, body: { error: '请选择站点并填写有效排查编号' } };
            }
            let account;
            try {
                account = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-diagnostics-credentials.json'), 'utf8'))[site];
            } catch { /* An unconfigured private connector must not expose filesystem details. */ }
            if (!account || typeof account.key !== 'string' || account.key.length < 32) {
                return { status: 503, body: { error: '该站点的管理员诊断连接尚未配置' } };
            }
            const url = `https://${HOSTS[site]}/internal/diagnostics?${new URLSearchParams(review ? { review: '1' } : { requestId, includeRelayLog: '1' })}`;
            try {
                const response = await fetchImpl(url, { headers: { 'x-corvas-diagnostics-key': account.key,
                    accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
                if (response.status === 404) return { status: 404, body: { error: '未找到该编号的服务端记录。请核对站点、编号及保留时间；客户端未发送的请求需查看客户提交的本地诊断，未找到记录不能判断扣费状态。' } };
                if (!response.ok) throw new Error('Diagnostic service unavailable');
                const text = await response.text();
                if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Diagnostic response too large');
                const record = JSON.parse(text);
                if (!record || typeof record !== 'object') throw new Error('Invalid diagnostic response');
                return { status: 200, body: { site, requestId, record } };
            } catch {
                return { status: 502, body: { error: '诊断服务暂时无法连接，请稍后查询；本操作不会重发生成请求。' } };
            }
        }
    };
}
