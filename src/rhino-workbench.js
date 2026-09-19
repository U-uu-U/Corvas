export { RHINO_EDIT_SKILL } from '../shared/rhino-model-skill.mjs';

export function createRhinoPanel({ onClose, onAgent }) {
    const host = document.getElementById('agentSidebarWrapper');
    if (!host) return null;
    const root = document.createElement('aside');
    root.id = 'rhinoWorkbenchPanel'; root.className = 'hunyuan-accounts-panel rhino-workbench-panel';
    root.hidden = true; root.setAttribute('aria-label', 'Rhino 工作台');
    root.innerHTML = `<header class="hunyuan-panel-head"><div><span class="corvas-rhino-mark">Rh</span><h2>Rhino</h2></div>
        <button type="button" data-action="close" aria-label="关闭 Rhino 侧栏">×</button></header>
        <div class="rhino-workbench-content"><div class="hunyuan-panel-intro"><strong>模型预览与编辑</strong><p>在 Rhino 中调整模型，在 Agent 中描述你想做的事。</p></div>
        <section class="rhino-connection-card"><div class="rhino-connection-state"><i></i><strong data-state>未连接</strong><span data-tools></span></div>
            <p data-message role="status" aria-live="polite"></p>
            <div class="rhino-connection-actions"><button type="button" data-action="open">打开并连接</button><button type="button" data-action="connect">仅连接</button></div>
        </section>
        <div class="rhino-workbench-tasks"><button type="button" data-action="inspect"><strong>预览当前模型</strong><span>先检查场景、选择和模型信息</span></button>
            <button type="button" data-action="quad"><strong>整理四边面</strong><span>保留原模型，在副本上清理和重拓扑</span></button>
            <button type="button" data-action="agent">与 Agent 协作 →</button></div>
        <details class="rhino-workbench-settings"><summary>连接设置</summary><form>
            <label>Rhino 程序<select name="executablePath" aria-label="Rhino 程序"></select></label>
            <button type="button" data-action="choose">选择其他程序…</button>
            <label>MCP 地址<input name="endpoint" type="url" required aria-label="Rhino MCP 地址"></label>
            <div><button type="submit">保存设置</button><button type="button" data-action="copy">复制连接命令</button></div>
            <p>需安装兼容的 Cordyceps。若已有 Rhino 窗口未连接，可将连接命令粘贴到 Rhino 执行后重试。</p>
        </form></details></div>`;
    host.append(root);
    const api = window.flowCanvas?.rhino;
    const form = root.querySelector('form');
    const message = root.querySelector('[data-message]');
    let state = {}; let timer; let editing = false; let working = false;
    const render = next => {
        state = next;
        root.dataset.state = state.state;
        root.querySelector('[data-state]').textContent = ({ idle: '未连接', connecting: '正在连接', launching: '正在启动 Rhino', waiting: '等待软件就绪', connected: '已连接', disconnected: '连接已断开', error: '需要处理' })[state.state] || '未连接';
        root.querySelector('[data-tools]').textContent = state.connected ? `${state.toolCount} 个工具` : '';
        message.textContent = state.message || '点击“打开并连接”开始使用。';
        root.querySelector('[data-action="open"]').textContent = state.connected ? '切换到 Rhino' : '打开并连接';
        for (const button of root.querySelectorAll('button')) {
            button.disabled = !['close', 'copy'].includes(button.dataset.action) && (working || state.busy || !api);
            if (['inspect', 'quad', 'agent'].includes(button.dataset.action)) button.disabled ||= !state.connected;
        }
        for (const input of form.querySelectorAll('input, select')) input.disabled = Boolean(working || state.busy);
        if (!editing) {
            const select = form.elements.namedItem('executablePath'); select.replaceChildren();
            if (!(state.applications || []).length) select.add(new Option('未检测到，请选择程序', ''));
            for (const application of state.applications || []) select.add(new Option(application.name, application.path));
            if (state.executablePath) select.value = state.executablePath;
            form.elements.namedItem('endpoint').value = state.endpoint || 'http://127.0.0.1:26929/mcp';
        }
    };
    const refresh = async () => {
        if (!api) { message.textContent = '请重启 Corvas 源码版后使用 Rhino 连接。'; return; }
        try { render(await api.status()); } catch (error) { message.textContent = error.message; }
    };
    const perform = async action => {
        if (working || !api) return;
        working = true; render(state);
        try { const next = await action(); if (next) render(next); }
        catch (error) { message.textContent = error.message || 'Rhino 操作失败'; }
        finally { working = false; render({ ...state, message: message.textContent }); }
    };
    form.addEventListener('input', () => { editing = true; });
    form.addEventListener('submit', event => {
        event.preventDefault();
        void perform(async () => {
            const next = await api.save({ executablePath: form.elements.namedItem('executablePath').value,
                endpoint: form.elements.namedItem('endpoint').value.trim() });
            editing = false; return next;
        });
    });
    root.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'close') return onClose();
        if (action === 'inspect') return onAgent('请检查 Rhino 当前文档和选中的模型，告诉我它的几何类型、尺寸和网格情况，先不要修改模型。');
        if (action === 'quad') return onAgent('请先检查 Rhino 中选中的网格，在副本上清理并转换为适合微调的四边面，保留原模型和材质，不转 NURBS。');
        if (action === 'agent') return onAgent('');
        if (action === 'copy') return void api?.copyCommand().then(() => { message.textContent = '连接命令已复制，请粘贴到 Rhino 命令栏执行。'; }).catch(error => { message.textContent = error.message; });
        if (action === 'choose') return void perform(async () => { const next = await api.choose(); editing = false; return next; });
        if (action === 'open' || action === 'connect') void perform(() => api.open({ connectOnly: action === 'connect' }));
    });
    const unsubscribe = api?.onChanged(render);
    window.addEventListener('pagehide', () => { clearInterval(timer); unsubscribe?.(); }, { once: true });
    return {
        setVisible(visible) {
            root.hidden = !visible; clearInterval(timer);
            if (visible) { void refresh(); timer = setInterval(refresh, 3000); }
        },
        launch() { if (api) void perform(() => api.open()); }
    };
}
