import { creativeAppIcon } from './creative-app-icons.js';

const icon = name => `<svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-${name}"></use></svg>`;
const hunyuanLogo = creativeAppIcon('hunyuan');

export function createApplicationLauncher({ onSelect }) {
    const trigger = document.getElementById('agentToggleBtn');
    if (!trigger) return null;
    const menu = document.createElement('section');
    menu.id = 'corvasAppLauncher';
    menu.className = 'corvas-app-launcher';
    menu.setAttribute('aria-label', '创作应用');
    menu.hidden = true;
    menu.innerHTML = `<div class="corvas-app-launcher-group" role="group" aria-label="AI 助手">
        <span class="corvas-app-launcher-label">AI 助手</span>
        <button type="button" data-app="agent">${icon('sparkles')}<span>AI Agent</span></button>
        <button type="button" data-app="settings" id="agentSettingsBtn" title="设置" aria-label="设置"
            aria-controls="agentSidebar" aria-expanded="false">${icon('settings')}<span>设置</span></button>
        </div>
        <div class="corvas-app-launcher-group" role="group" aria-label="网页创作">
        <span class="corvas-app-launcher-label">网页创作</span>
        <button type="button" data-app="relay" title="打开个人站或企业站">${icon('window')}<span>中转站</span></button>
        <button type="button" data-app="tripo" title="打开 Tripo 创作平台">${creativeAppIcon('tripo')}<span>Tripo</span></button>
        <button type="button" data-app="hunyuan">${hunyuanLogo}<span>混元 3D</span></button>
        <button type="button" data-app="jimeng" title="打开即梦创作平台">${creativeAppIcon('jimeng')}<span>即梦</span></button>
        </div>
        <div class="corvas-app-launcher-group" role="group" aria-label="本地软件">
        <span class="corvas-app-launcher-label">本地软件</span>
        <button type="button" data-app="rhino">${creativeAppIcon('rhino')}<span>Rhino</span></button>
        <button type="button" data-app="blender">${creativeAppIcon('blender')}<span>Blender</span></button>
        </div>
        <p class="corvas-app-launcher-status" role="status" hidden></p>`;
    document.body.append(menu);
    let timer;
    const hide = () => { clearTimeout(timer); menu.hidden = true; };
    const show = () => {
        clearTimeout(timer);
        menu.hidden = false;
        const bounds = trigger.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
        const top = bounds.top - menu.offsetHeight - 10;
        menu.style.top = `${Math.max(8, Math.min(top, innerHeight - menu.offsetHeight - 8))}px`;
    };
    const deferHide = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (!menu.matches(':hover') && !trigger.matches(':hover') && !menu.contains(document.activeElement)) hide();
        }, 180);
    };
    for (const element of [trigger, menu]) {
        element.addEventListener('pointerenter', show);
        element.addEventListener('pointerleave', deferHide);
        element.addEventListener('focusin', show);
        element.addEventListener('focusout', deferHide);
    }
    trigger.addEventListener('keydown', event => {
        if (event.key !== 'ArrowUp') return;
        event.preventDefault();
        show();
        menu.querySelector('button').focus();
    });
    trigger.addEventListener('click', hide);
    menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); trigger.focus(); hide(); }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const buttons = [...menu.querySelectorAll('button')];
            const index = buttons.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
            buttons[next].focus();
        }
    });
    menu.addEventListener('click', async event => {
        const button = event.target.closest('[data-app]');
        if (!button) return;
        hide();
        const status = menu.querySelector('[role="status"]');
        status.hidden = true;
        try { await onSelect(button.dataset.app); }
        catch (error) {
            status.textContent = error.message || '打开失败，请重试';
            status.hidden = false;
            show();
        }
    });
    document.addEventListener('pointerdown', event => {
        if (!menu.contains(event.target) && !trigger.contains(event.target)) hide();
    });
    window.addEventListener('resize', hide);
    return { hide };
}

export function createHunyuanPanel({ onClose, onAgent }) {
    const wrapper = document.getElementById('agentSidebarWrapper');
    if (!wrapper) return null;
    const root = document.createElement('aside');
    root.id = 'hunyuanAccountsPanel';
    root.className = 'hunyuan-accounts-panel';
    root.setAttribute('aria-label', '混元账号');
    root.hidden = true;
    root.innerHTML = `<header class="hunyuan-panel-head"><div>${hunyuanLogo}<h2>混元 3D</h2></div>
        <button type="button" data-action="close" title="关闭侧边栏" aria-label="关闭混元账号侧栏">${icon('close')}</button></header>
        <div class="hunyuan-panel-intro"><strong>选择一个账号开始创作</strong>
            <p>各账号使用独立浏览器环境，可同时打开。首次使用请在各自窗口中登录。</p></div>
        <div class="hunyuan-account-toolbar"><span>我的账号 <small data-count>0</small></span>
            <button type="button" data-action="add">${icon('add')}添加账号</button></div>
        <form class="hunyuan-account-form" hidden><label for="hunyuanAccountName">账号名称</label>
            <input id="hunyuanAccountName" name="name" maxlength="40" required autocomplete="off" placeholder="例如：设计主账号">
            <div><button type="button" data-action="cancel">取消</button><button type="submit" class="primary">保存</button></div></form>
        <p class="hunyuan-panel-status" role="status" aria-live="polite" hidden></p>
        <div class="hunyuan-account-list"></div>
        <footer class="hunyuan-panel-footer"><span>腾讯混元 3D 官方网页</span>
            <button type="button" data-action="agent">返回 AI Agent</button></footer>`;
    wrapper.append(root);
    const api = window.flowCanvas?.hunyuan;
    const form = root.querySelector('form');
    const input = form.elements.namedItem('name');
    const list = root.querySelector('.hunyuan-account-list');
    const status = root.querySelector('[role="status"]');
    let data = { accounts: [] };
    let editing = null;
    let deleting = null;
    let busy = false;
    let refreshId = 0;
    const message = (text = '', error = false) => {
        status.textContent = text;
        status.hidden = !text;
        status.classList.toggle('is-error', error);
    };
    const button = (label, action, symbol) => {
        const element = document.createElement('button');
        element.type = 'button'; element.dataset.action = action;
        element.title = label; element.setAttribute('aria-label', label);
        if (symbol) element.innerHTML = icon(symbol);
        else element.textContent = label;
        return element;
    };
    function render(next = data) {
        data = next;
        root.querySelector('[data-count]').textContent = String(data.accounts.length);
        list.replaceChildren();
        if (data.error) message(data.error, true);
        if (!data.accounts.length) {
            const empty = document.createElement('div');
            empty.className = 'hunyuan-accounts-empty';
            empty.innerHTML = `${hunyuanLogo}<strong>添加你的第一个混元账号</strong><p>为账号取个便于区分的名字，<br>然后打开网页登录。</p>`;
            list.append(empty);
        }
        for (const account of data.accounts) {
            const row = document.createElement('article');
            row.className = 'hunyuan-account'; row.dataset.accountId = account.id;
            const avatar = document.createElement('span'); avatar.className = 'hunyuan-account-avatar';
            avatar.textContent = account.name.slice(0, 1).toUpperCase();
            const copy = document.createElement('div'); copy.className = 'hunyuan-account-copy';
            const title = document.createElement('strong'); title.textContent = account.name; title.title = account.name;
            const state = document.createElement('span');
            state.textContent = { loading: '网页加载中…', open: '窗口已打开', error: '浏览器打开失败，点击重试', closed: '独立登录环境' }[account.status] || '独立登录环境';
            state.className = `hunyuan-account-state ${account.status || 'closed'}`;
            copy.append(title, state);
            const open = button(account.status === 'error' ? '重试' : account.windowOpen ? '切换窗口' : '打开', 'open');
            open.className = 'hunyuan-account-open';
            const actions = document.createElement('div'); actions.className = 'hunyuan-account-actions';
            actions.append(button('重命名', 'rename', 'tag'), button('移除账号', 'remove', 'trash'));
            row.append(avatar, copy, open, actions);
            if (deleting === account.id) {
                const confirm = document.createElement('div'); confirm.className = 'hunyuan-account-remove';
                const note = document.createElement('p'); note.textContent = '移除后将关闭该账号窗口并清除本机登录状态，混元网站中的作品不受影响。';
                confirm.append(note, button('取消', 'cancel-remove'), button('移除并清除登录', 'confirm-remove'));
                row.append(confirm);
            }
            list.append(row);
        }
        setBusy(busy);
    }
    function setBusy(value) {
        busy = value;
        root.querySelectorAll('button, input').forEach(element => {
            if (!['close', 'agent'].includes(element.dataset.action)) element.disabled = value || !api || Boolean(data.error);
        });
    }
    async function perform(work) {
        if (busy) return;
        if (!api) return message('请在 Corvas 桌面应用中打开混元账号。', true);
        setBusy(true); message();
        try { await work(); } catch (error) { message(error.message || '操作失败，请重试。', true); }
        finally { setBusy(false); }
    }
    function edit(account = null) {
        editing = account; deleting = null;
        form.hidden = false;
        input.value = account?.name || '';
        input.focus();
        render();
    }
    root.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'close') return onClose();
        if (action === 'agent') return onAgent();
        if (busy) return;
        if (action === 'add') return edit();
        if (action === 'cancel') { form.hidden = true; editing = null; return; }
        const id = event.target.closest('[data-account-id]')?.dataset.accountId;
        const account = data.accounts.find(entry => entry.id === id);
        if (!account) return;
        if (action === 'rename') return edit(account);
        if (action === 'remove' || action === 'cancel-remove') { deleting = action === 'remove' ? id : null; render(); return; }
        void perform(async () => {
            if (action === 'open') render(await api.open({ id }));
            if (action === 'confirm-remove') {
                render(await api.remove({ id })); deleting = null;
                if (editing?.id === id) { editing = null; form.hidden = true; }
            }
        });
    });
    form.addEventListener('submit', event => {
        event.preventDefault();
        void perform(async () => {
            const saved = await api.save({ ...(editing ? { id: editing.id } : {}), name: input.value.trim() });
            form.hidden = true; editing = null; render(saved);
            message('账号已保存，点击“打开”进入混元网页。');
        });
    });
    root.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        if (!form.hidden) { form.hidden = true; editing = null; }
        else if (deleting) { deleting = null; render(); }
        else onClose();
    });
    const unsubscribe = api?.onChanged(next => { refreshId++; render(next); });
    window.addEventListener('pagehide', () => unsubscribe?.(), { once: true });
    return {
        setVisible(visible) {
            root.hidden = !visible;
            if (!visible) return;
            if (!api) { render(); message('请在 Corvas 桌面应用中打开混元账号。', true); return; }
            const request = ++refreshId;
            message('正在读取账号…');
            void api.list().then(next => {
                if (request !== refreshId) return;
                message(); render(next);
            }).catch(error => message(error.message || '账号读取失败', true));
            root.querySelector('[data-action="add"]').focus();
        }
    };
}
