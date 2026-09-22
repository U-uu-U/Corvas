export function initAdminBalances(document) {
    const window = document.defaultView;
    const rows = document.getElementById('balanceRows');
    const state = document.getElementById('balanceState');
    const message = document.getElementById('balanceMessage');
    const button = document.getElementById('refreshBalancesBtn');
    if (!rows) return;
    let busy = false;
    const csrf = document.querySelector('#configForm input[name="csrf"]').value;
    const cell = (row, text = '') => { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; };
    const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未查询';
    async function request(url, body) {
        const response = await window.fetch(url, { credentials: 'same-origin', cache: 'no-store',
            ...(body ? { method: 'POST', headers: { Accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) }
                : { headers: { Accept: 'application/json' } }) });
        if (response.status === 401) throw new Error('登录已过期，请重新登录');
        if (!response.ok) throw new Error('余额服务暂时无法访问');
        return response.json();
    }
    function render(accounts) {
        rows.replaceChildren();
        for (const account of accounts) {
            const row = document.createElement('tr');
            row.dataset.low = String(account.low);
            const name = cell(row, account.name);
            const label = document.createElement('small'); label.textContent = account.account; name.append(label);
            const amount = cell(row, account.amount === null ? '--' : new Intl.NumberFormat('zh-CN', {
                style: 'currency', currency: account.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(account.amount));
            amount.className = 'balance-amount';
            const scope = document.createElement('small'); scope.textContent = account.scope; amount.append(scope);
            const threshold = cell(row);
            if (account.editable) {
                const input = document.createElement('input');
                input.type = 'number'; input.min = '0'; input.max = '1000000'; input.step = '0.01';
                input.value = account.threshold === null ? '' : String(account.threshold);
                input.placeholder = '关闭'; input.setAttribute('aria-label', `${account.name}低余额预警线`);
                input.addEventListener('change', async () => {
                    if (!input.reportValidity()) return;
                    input.disabled = true;
                    try {
                        await request('/admin/balances/threshold', { id: account.id, threshold: input.value === '' ? null : Number(input.value) });
                        message.textContent = `${account.name}预警线已保存`;
                        await load();
                    } catch (error) { message.textContent = error.message; }
                    finally { input.disabled = false; }
                });
                threshold.append(input);
                const currency = document.createElement('small'); currency.textContent = account.currency; threshold.append(currency);
            } else threshold.textContent = '--';
            const status = cell(row, account.status === 'ok' ? account.low ? '余额偏低' : '正常'
                : account.status === 'stale' ? '查询失败，显示上次余额' : account.status === 'error' ? '查询失败' : '待接入');
            status.className = 'balance-status';
            if (account.detail) { const detail = document.createElement('small'); detail.textContent = account.detail; status.append(detail); }
            cell(row, time(account.updatedAt));
            const linkCell = cell(row);
            if (account.url) {
                const link = document.createElement('a'); link.href = account.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
                link.textContent = '打开上游'; linkCell.append(link);
            }
            rows.append(row);
        }
    }
    async function load(force = false) {
        if (busy) return;
        busy = true; button.disabled = true; state.textContent = '查询中';
        try {
            const data = await request(force ? '/admin/balances/refresh' : '/admin/balances', force ? {} : undefined);
            render(data.accounts);
            state.textContent = `已接入 ${data.accounts.filter(account => account.status !== 'unavailable').length} / ${data.accounts.length}`;
        } catch (error) { state.textContent = error.message; }
        finally { busy = false; button.disabled = false; }
    }
    button.addEventListener('click', () => load(true));
    void load();
    const timer = window.setInterval(() => {
        if (!document.hidden && !rows.contains(document.activeElement)) void load();
    }, 5 * 60 * 1000);
    window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
}

if (globalThis.document) initAdminBalances(globalThis.document);
