import relaySites from '../shared/relay-sites.cjs';

const { SITES } = relaySites;
const icon = name => `<svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-${name}"></use></svg>`;

export function createSiteLogin({ getProviders }) {
    const root = document.getElementById('agentStationAccounts');
    if (!root) return null;
    const api = window.flowCanvas?.relay;
    let snapshot = {};
    let opening = '';
    const dialog = document.createElement('dialog');
    dialog.id = 'siteLoginDialog';
    dialog.className = 'site-login-dialog';
    const logo = new URL('../electron-main/assets/app-icon.png', import.meta.url).href;
    dialog.innerHTML = `<header><img src="${logo}" alt="Corvas"><h1>登录 Corvas</h1></header>
        <div class="site-login-choices">${Object.entries(SITES).map(([site, info]) => `
            <button type="button" data-login-site="${site}">${icon(info.icon)}<strong>${info.name}</strong><small>${new URL(info.origin).hostname}</small></button>`).join('')}</div>
        <p class="site-login-status" role="status"></p><footer><button type="button" data-login-skip>暂不登录</button></footer>`;
    dialog.setAttribute('aria-label', '登录 Corvas');
    document.body.append(dialog);
    root.innerHTML = Object.entries(SITES).map(([site, info]) => `
        <article class="site-account" data-station="${site}">
            <div class="site-account-heading">${icon(info.icon)}<strong>${info.name}</strong><span data-station-state></span></div>
            <span class="site-account-domain">${new URL(info.origin).hostname}</span>
            <span class="site-account-user" data-station-user></span>
            <div class="site-account-actions"><button type="button" data-login-site="${site}">登录</button>
                <button type="button" data-open-site="${site}" title="打开后台" aria-label="打开${info.name}后台">${icon('window')}</button></div>
        </article>`).join('');
    const status = document.getElementById('agentStationStatus');
    const message = text => { if (status) status.textContent = text; dialog.querySelector('[role=status]').textContent = text; };
    function render() {
        const providers = getProviders();
        for (const [site, info] of Object.entries(SITES)) {
            const card = root.querySelector(`[data-station="${site}"]`);
            const linked = providers.find(provider => provider.relayAccount?.site === site);
            const legacy = providers.some(provider => {
                try { return new URL(provider.endpoint).origin === info.origin && provider.apiKey; } catch { return false; }
            });
            const state = snapshot.accounts?.[site];
            const connected = Boolean(linked);
            card.dataset.state = state?.state === 'error' ? 'error' : connected ? 'connected' : 'signed-out';
            card.querySelector('[data-station-state]').textContent = state?.state === 'connecting' ? '正在认证'
                : state?.state === 'error' ? '认证未完成' : connected ? '已连接' : legacy ? '已有配置' : '未登录';
            card.querySelector('[data-station-user]').textContent = state?.state === 'error' ? state.message
                : linked?.relayAccount.username || state?.username || '';
            const button = card.querySelector('[data-login-site]');
            button.textContent = connected ? '登录认证' : '登录';
            button.disabled = Boolean(opening) || !api?.open;
            card.querySelector('[data-open-site]').disabled = Boolean(opening) || !api?.open;
        }
        for (const button of dialog.querySelectorAll('[data-login-site]')) button.disabled = Boolean(opening) || !api?.open;
        if (providers.some(provider => provider.relayAccount) && dialog.open) dialog.close();
    }
    async function open(site, login) {
        if (opening) return;
        if (!api?.open) { message('请重启画布后使用登录认证'); return; }
        opening = site; render(); message('');
        try {
            await api.open({ site, login });
            if (dialog.open) dialog.close();
        } catch { message('站点未能打开，请稍后重试'); }
        finally { opening = ''; render(); }
    }
    for (const element of [root, dialog]) element.addEventListener('click', event => {
        const login = event.target.closest('[data-login-site]');
        const backend = event.target.closest('[data-open-site]');
        if (login) void open(login.dataset.loginSite, true);
        else if (backend) void open(backend.dataset.openSite, false);
    });
    const skip = async () => {
        try { snapshot = await api.skipOnboarding(); if (dialog.open) dialog.close(); }
        catch { message('暂未保存，请重试'); }
    };
    dialog.querySelector('[data-login-skip]').addEventListener('click', () => { void skip(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); void skip(); });
    api?.onState?.(state => { snapshot = state; render(); });
    render();
    return { render, async start() {
        if (!api?.status) return;
        try {
            snapshot = await api.status(); render();
            if (!snapshot.onboardingSkipped && !getProviders().some(provider => provider.apiKey) && !dialog.open) dialog.showModal();
        } catch { message('登录状态暂时无法读取'); }
    } };
}
