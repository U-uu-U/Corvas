import './mcp-startup-notice.css';
import { describeMcpServerStatus } from './mcp-server-status.js';

const DISPLAY_MS = 20_000;
const icon = name => `<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-${name}"></use></svg>`;

export function mountMcpStartupNotice() {
    const api = window.flowCanvas?.mcpServer;
    if (!api?.status || document.getElementById('mcpStartupNotice')) return;
    const root = document.createElement('aside');
    root.id = 'mcpStartupNotice';
    root.className = 'mcp-startup-notice';
    root.setAttribute('aria-label', 'HTTP MCP 连接');
    root.hidden = true;
    root.innerHTML = `<header><strong>${icon('connections')}HTTP MCP</strong>
        <span data-countdown>20 秒</span><button type="button" data-action="close" title="关闭" aria-label="关闭 HTTP MCP 提示">${icon('close')}</button></header>
        <p data-state role="status" aria-live="polite"></p>
        <code data-url></code>
        <footer><button type="button" data-action="copy-url" title="复制 HTTP MCP 地址">${icon('copy')}复制地址</button>
        <button type="button" data-action="copy" title="复制 MCP JSON 配置">${icon('copy')}复制配置</button></footer>
        <p data-feedback role="status" aria-live="polite"></p>`;
    document.body.append(root);
    let current;
    let remaining = DISPLAY_MS;
    let lastTick = performance.now();
    let refreshing = false;
    let disposed = false;
    let nextRefresh = 0;
    const state = root.querySelector('[data-state]');
    const countdown = root.querySelector('[data-countdown]');
    const feedback = root.querySelector('[data-feedback]');
    const copyButtons = [...root.querySelectorAll('footer button')];
    const close = () => {
        disposed = true;
        clearInterval(timer);
        unsubscribe?.();
        window.removeEventListener('pagehide', close);
        root.remove();
    };
    const render = next => {
        current = next;
        state.textContent = next.running ? (next.boardToolsReady ? '服务已就绪' : '服务已启动，画布准备中') : describeMcpServerStatus(next);
        root.dataset.state = next.running ? 'ready' : next.error ? 'error' : 'stopped';
        root.querySelector('[data-url]').textContent = next.url;
    };
    async function refresh() {
        if (refreshing || disposed) return;
        refreshing = true;
        try { const next = await api.status(); if (!disposed) render(next); }
        catch { if (!disposed) close(); }
        finally { refreshing = false; }
    }
    function tick() {
        const now = performance.now();
        const elapsed = now - lastTick;
        lastTick = now;
        const canShow = current?.windowVisible && document.visibilityState === 'visible'
            && !document.querySelector('dialog[open]');
        if (canShow && !root.hidden) remaining -= elapsed;
        root.hidden = !canShow;
        if (remaining <= 0) { close(); return; }
        countdown.textContent = `${Math.ceil(remaining / 1000)} 秒`;
        if (now >= nextRefresh) { nextRefresh = now + 1000; void refresh(); }
    }
    const timer = setInterval(tick, 100);
    const unsubscribe = api.onShown?.(() => { void refresh(); });
    window.addEventListener('pagehide', close, { once: true });
    root.addEventListener('click', async event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'close') { close(); return; }
        if (action !== 'copy' && action !== 'copy-url') return;
        copyButtons.forEach(button => { button.disabled = true; });
        try {
            const next = await (action === 'copy-url' ? api.copyUrl() : api.copy());
            if (!disposed) {
                render(next);
                feedback.textContent = `${action === 'copy-url' ? '地址' : '配置'}已复制${next.running ? '' : '（服务未启动）'}`;
            }
        } catch { feedback.textContent = '复制失败，请重试'; }
        finally { copyButtons.forEach(button => { button.disabled = false; }); }
    });
    void refresh();
    return close;
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountMcpStartupNotice, { once: true });
    else mountMcpStartupNotice();
}
