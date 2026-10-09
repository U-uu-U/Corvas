import './mcp-client-settings.css';
import { formatClientStatusMessage } from './generation-progress.js';
import { describeMcpServerStatus } from './mcp-server-status.js';

export function mountMcpServerSettings() {
    const host = document.getElementById('agentApiSettingsPane');
    if (!host || document.getElementById('mcpServerSettings')) return;
    const root = document.createElement('section');
    root.id = 'mcpServerSettings';
    root.className = 'mcp-client-settings mcp-server-settings';
    root.innerHTML = `
        <div class="agent-settings-section-head"><strong>MCP Server</strong></div>
        <small class="mcp-server-hint">让 Claude Code、Codex 等其他 Agent 通过 Streamable HTTP 调用 Corvas。仅本机可连接，无额外认证。</small>
        <div class="mcp-client-status" role="status" aria-live="polite"></div>
        <div class="mcp-client-actions">
            <button type="button" data-action="toggle">启动</button>
            <button type="button" data-action="copy">复制连接信息</button>
        </div>`;
    host.insertBefore(root, document.getElementById('mcpClientSettings') || document.getElementById('agentApiDiagnostics'));
    const api = window.flowCanvas?.mcpServer;
    const status = root.querySelector('[role=status]');
    const toggle = root.querySelector('[data-action=toggle]');
    const buttons = [...root.querySelectorAll('button')];
    let current = null;
    let busy = false;
    const render = (next, note = '') => {
        current = next;
        status.textContent = formatClientStatusMessage(note || describeMcpServerStatus(next));
        status.classList.toggle('error', Boolean(!note && next?.enabled && !next?.running && next?.error));
        toggle.textContent = next?.running ? '关闭' : '启动';
        toggle.setAttribute('aria-label', next?.running ? '关闭 MCP Server' : '启动 MCP Server');
    };
    async function perform(work) {
        if (busy) return;
        if (!api) { status.textContent = 'MCP Server 需要在桌面应用中使用'; status.classList.add('error'); return; }
        busy = true;
        buttons.forEach(button => { button.disabled = true; });
        try { await work(); }
        catch (error) { status.textContent = formatClientStatusMessage(error.message || String(error)); status.classList.add('error'); }
        finally { busy = false; buttons.forEach(button => { button.disabled = false; }); }
    }
    root.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (!action) return;
        void perform(async () => {
            if (action === 'toggle') render(await (current?.running ? api.stop() : api.start()));
            if (action === 'copy') {
                const next = await api.copy();
                render(next, `已复制连接信息 · ${next.url}${next.running ? '' : '（服务当前未启动）'}`);
            }
        });
    });
    void perform(async () => render(await api.status()));
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountMcpServerSettings, { once: true });
    else mountMcpServerSettings();
}
