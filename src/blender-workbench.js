import { mountExternalHandoff } from './external-handoff.js';

export function createBlenderPanel({ onClose, onHandoff, getProjectId = () => null }) {
    const host = document.getElementById('agentSidebarWrapper');
    if (!host) return null;
    const root = document.createElement('aside');
    root.id = 'blenderWorkbenchPanel'; root.className = 'hunyuan-accounts-panel blender-workbench-panel'; root.hidden = true;
    root.setAttribute('aria-label', 'Blender 工作台');
    root.innerHTML = `<header class="hunyuan-panel-head"><div><span class="corvas-blender-mark">B</span><h2>Blender</h2></div>
        <button type="button" data-action="close" aria-label="关闭 Blender 侧栏">×</button></header>
        <div class="blender-workbench-content"><div class="hunyuan-panel-intro"><strong>动画与场景编辑</strong><p>Codex · Blender MCP</p></div>
        <section class="blender-connection-card"><div class="blender-connection-state"><i></i><strong data-state>未连接</strong><span data-tools></span></div>
            <p data-message role="status" aria-live="polite">点击“打开并连接”开始使用。</p>
            <div class="blender-connection-actions"><button type="button" data-action="open">打开并连接</button></div></section>
        <div class="blender-workbench-tasks"><button type="button" data-action="inspect"><strong>预览当前场景</strong><span>对象、相机和动画时间线</span></button>
            <button type="button" data-action="animate"><strong>制作一个小动画</strong><span>准备镜头、关键帧和低成本预览要求</span></button>
            <button type="button" data-action="handoff">新建 Codex 任务</button></div>
        <section data-handoff></section>
        <details class="blender-workbench-settings"><summary>连接设置</summary><form>
            <label>Blender 程序<select name="executablePath" aria-label="Blender 程序"></select></label>
            <button type="button" data-action="choose">选择其他程序…</button>
            <p>请先在设置 > API > MCP 外部软件连接中添加 Blender MCP，并在名称中包含 Blender。</p>
        </form></details></div>`;
    host.append(root);
    const handoff = mountExternalHandoff({ root, target: 'blender', getProjectId, onHandoff });
    const api = window.flowCanvas?.blender; const form = root.querySelector('.blender-workbench-settings form'); const message = root.querySelector('[data-message]');
    let state = {}; let timer; let busy = false; let editing = false;
    const render = next => {
        state = next || {}; root.dataset.state = state.state || 'idle';
        root.querySelector('[data-state]').textContent = ({ idle: '未连接', connecting: '正在连接', connected: '已连接', error: '需要处理' })[state.state] || '未连接';
        root.querySelector('[data-tools]').textContent = state.connected ? `${state.toolCount} 个工具` : '';
        message.textContent = state.message || '点击“打开并连接”开始使用。';
        for (const button of root.querySelectorAll('button:not([data-handoff-action])')) {
            button.disabled = ['inspect', 'animate', 'handoff'].includes(button.dataset.action)
                ? !window.flowCanvas?.handoff : button.dataset.action !== 'close' && (busy || state.busy || !api);
        }
        for (const input of form.querySelectorAll('input, select')) input.disabled = Boolean(busy || state.busy);
        if (!editing) { const select = form.elements.namedItem('executablePath'); select.replaceChildren();
            if (!(state.applications || []).length) select.add(new Option('未检测到，请选择程序', ''));
            for (const application of state.applications || []) select.add(new Option(application.name, application.path));
            if (state.executablePath) {
                if (!(state.applications || []).some(application => application.path === state.executablePath)) {
                    select.add(new Option(state.executablePath, state.executablePath));
                }
                select.value = state.executablePath;
            }
        }
    };
    const perform = async work => { if (busy || !api) return; busy = true; render(state); try { render(await work()); }
        catch (error) { message.textContent = error.message || 'Blender 操作失败'; }
        finally { busy = false; render({ ...state, message: message.textContent }); } };
    const refresh = () => api?.status?.().then(render).catch(error => { message.textContent = error.message; });
    form.addEventListener('input', () => { editing = true; });
    form.addEventListener('change', event => {
        if (event.target.name !== 'executablePath' || !event.target.value) return;
        const executablePath = event.target.value;
        void perform(async () => {
            try { return await api.save({ executablePath }); }
            finally { editing = false; }
        });
    });
    root.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'close') return onClose();
        if (action === 'handoff') return handoff.focus();
        if (action === 'inspect') return void handoff.create('请读取 Blender 当前场景、选中对象、相机、帧率和时间范围，先不要修改。');
        if (action === 'animate') return void handoff.create('请根据当前 Blender 场景制作一个低成本小动画预览，先读取场景并向我说明镜头、时长和关键帧计划，再执行。');
        if (action === 'choose') return void perform(async () => { editing = false; return api.choose(); });
        if (action === 'open') return void perform(() => api.open());
    });
    const unsubscribe = api?.onChanged(render);
    window.addEventListener('pagehide', () => { clearInterval(timer); handoff.dispose(); unsubscribe?.(); }, { once: true });
    return { setVisible(visible) { root.hidden = !visible; handoff.setVisible(visible); clearInterval(timer); if (visible) { refresh(); timer = setInterval(refresh, 3000); } }, launch() { void perform(() => api?.open()); } };
}
