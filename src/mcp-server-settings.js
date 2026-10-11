import './mcp-client-settings.css';
import './mcp-startup-notice.js';
import { formatClientStatusMessage } from './generation-progress.js';
import { describeMcpServerStatus } from './mcp-server-status.js';

const icon = name => `<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-${name}"></use></svg>`;

export function mountMcpServerSettings() {
    const host = document.getElementById('agentCreationSettingsPane');
    if (!host || document.getElementById('mcpServerSettings')) return;
    const root = document.createElement('section');
    root.id = 'mcpServerSettings';
    root.className = 'mcp-client-settings mcp-server-settings';
    root.innerHTML = `
        <div class="agent-settings-section-head"><strong>HTTP MCP</strong>
            <label class="mcp-server-switch"><input type="checkbox" data-action="toggle" aria-label="启用 HTTP MCP">启用</label></div>
        <div class="mcp-client-status" role="status" aria-live="polite"></div>
        <div class="mcp-client-actions">
            <button type="button" data-action="copy-url" title="复制 HTTP MCP 地址">${icon('copy')}复制地址</button>
            <button type="button" data-action="copy" title="复制 MCP JSON 配置">${icon('copy')}复制配置</button>
        </div>`;
    host.insertBefore(root, host.querySelector(':scope > #mcpClientSettings, :scope > #agentApiDiagnostics'));
    const api = window.flowCanvas?.mcpServer;
    const status = root.querySelector('[role=status]');
    const toggle = root.querySelector('[data-action=toggle]');
    const controls = [...root.querySelectorAll('button, input')];
    let busy = false;
    const render = (next, note = '') => {
        status.textContent = formatClientStatusMessage(note || describeMcpServerStatus(next));
        status.classList.toggle('error', Boolean(!note && next?.enabled && !next?.running && next?.error));
        toggle.checked = next?.enabled === true;
    };
    async function perform(work) {
        if (busy) return;
        if (!api) { status.textContent = '请重启 Corvas 后使用 HTTP MCP'; status.classList.add('error'); return; }
        busy = true;
        controls.forEach(control => { control.disabled = true; });
        try { await work(); }
        catch (error) { status.textContent = formatClientStatusMessage(error.message || String(error)); status.classList.add('error'); }
        finally { busy = false; controls.forEach(control => { control.disabled = false; }); }
    }
    toggle.addEventListener('change', () => {
        void perform(async () => render(await (toggle.checked ? api.start() : api.stop())));
    });
    root.addEventListener('click', event => {
        const action = event.target.closest('button[data-action]')?.dataset.action;
        if (!action) return;
        void perform(async () => {
            const next = await (action === 'copy-url' ? api.copyUrl() : api.copy());
            render(next, `${action === 'copy-url' ? '地址' : '配置'}已复制${next.running ? '' : '（服务未启动）'}`);
        });
    });
    void perform(async () => render(await api.status()));
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountMcpServerSettings, { once: true });
    else mountMcpServerSettings();
}
