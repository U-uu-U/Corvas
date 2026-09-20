export const BLENDER_ANIMATION_SKILL = Object.freeze({
    id: 'blender-animation', name: 'Blender 动画', category: 'creative',
    description: '根据模型、镜头和运动要求制作小动画',
    instruction: '当用户要求操作 Blender 时，先使用已连接的 Blender MCP 读取当前场景、选中对象、相机、帧率和时间范围，确认工具 schema 后再操作。先询问或采用用户明确的模型、镜头、时长和输出要求；没有目标对象时不要猜测。制作动画前保存或创建可回退的场景版本，使用新集合或新动作数据保存本次修改，保留原始模型和材质。优先完成低成本预览：相机、灯光、关键帧和低分辨率测试渲染；用户确认后再提高采样、分辨率或帧数。不要把 Blender 场景撤销当成 Corvas 画布撤销。外部工具返回结果不确定时先读取场景确认，不重复执行。只有实际渲染文件已经存在并被画布接收后才声称完成。'
});

export function createBlenderPanel({ onClose, onAgent }) {
    const host = document.getElementById('agentSidebarWrapper');
    if (!host) return null;
    const root = document.createElement('aside');
    root.id = 'blenderWorkbenchPanel'; root.className = 'hunyuan-accounts-panel blender-workbench-panel'; root.hidden = true;
    root.setAttribute('aria-label', 'Blender 工作台');
    root.innerHTML = `<header class="hunyuan-panel-head"><div><span class="corvas-blender-mark">B</span><h2>Blender</h2></div>
        <button type="button" data-action="close" aria-label="关闭 Blender 侧栏">×</button></header>
        <div class="blender-workbench-content"><div class="hunyuan-panel-intro"><strong>动画与场景编辑</strong><p>在 Blender 中处理动画，在 Agent 中描述镜头和运动。</p></div>
        <section class="blender-connection-card"><div class="blender-connection-state"><i></i><strong data-state>未连接</strong><span data-tools></span></div>
            <p data-message role="status" aria-live="polite">点击“打开并连接”开始使用。</p>
            <div class="blender-connection-actions"><button type="button" data-action="open">打开并连接</button></div></section>
        <div class="blender-workbench-tasks"><button type="button" data-action="inspect"><strong>预览当前场景</strong><span>让 Agent 读取对象、相机和动画时间线</span></button>
            <button type="button" data-action="animate"><strong>制作一个小动画</strong><span>准备镜头、关键帧和低成本预览要求</span></button>
            <button type="button" data-action="agent">与 Agent 协作 →</button></div>
        <details class="blender-workbench-settings"><summary>连接设置</summary><form>
            <label>Blender 程序<select name="executablePath" aria-label="Blender 程序"></select></label>
            <button type="button" data-action="choose">选择其他程序…</button>
            <p>请先在设置 > API > MCP 外部工具中添加 Blender MCP，并在名称中包含 Blender。</p>
        </form></details></div>`;
    host.append(root);
    const api = window.flowCanvas?.blender; const form = root.querySelector('form'); const message = root.querySelector('[data-message]');
    let state = {}; let timer; let busy = false; let editing = false;
    const render = next => {
        state = next || {}; root.dataset.state = state.state || 'idle';
        root.querySelector('[data-state]').textContent = ({ idle: '未连接', connecting: '正在连接', connected: '已连接', error: '需要处理' })[state.state] || '未连接';
        root.querySelector('[data-tools]').textContent = state.connected ? `${state.toolCount} 个工具` : '';
        message.textContent = state.message || '点击“打开并连接”开始使用。';
        for (const button of root.querySelectorAll('button')) button.disabled = !['close'].includes(button.dataset.action) && (busy || state.busy || !api);
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
        if (action === 'agent') return onAgent('');
        if (action === 'inspect') return onAgent('请读取 Blender 当前场景、选中对象、相机、帧率和时间范围，先不要修改。');
        if (action === 'animate') return onAgent('请根据当前 Blender 场景制作一个低成本小动画预览，先读取场景并向我说明镜头、时长和关键帧计划，再执行。');
        if (action === 'choose') return void perform(async () => { editing = false; return api.choose(); });
        if (action === 'open') return void perform(() => api.open());
    });
    const unsubscribe = api?.onChanged(render);
    window.addEventListener('pagehide', () => { clearInterval(timer); unsubscribe?.(); }, { once: true });
    return { setVisible(visible) { root.hidden = !visible; clearInterval(timer); if (visible) { refresh(); timer = setInterval(refresh, 3000); } }, launch() { void perform(() => api?.open()); } };
}
