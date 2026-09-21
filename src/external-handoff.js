const STATUS_LABELS = Object.freeze({
    queued: '待 Codex 接手', running: '处理中', awaiting_user: '等待用户',
    completed: '完成', failed: '失败', canceled: '取消'
});
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);

export function handoffStatusLabel(status) {
    return STATUS_LABELS[status] || '状态未知';
}

export function createHandoffController({ api, target, getProjectId, onHandoff, onChange = () => {},
    newRequestId = () => crypto.randomUUID() }) {
    let tasks = [];
    let busy = false;
    let message = '';
    let pendingRequest = null;
    let refreshVersion = 0;
    const emit = () => onChange({ tasks: tasks.filter(task => task.projectId === getProjectId()), busy, message });
    const refresh = async () => {
        if (!api?.list) return;
        const projectId = getProjectId();
        const version = ++refreshVersion;
        try {
            const result = await api.list({ projectId, target });
            if (version !== refreshVersion || projectId !== getProjectId()) return;
            tasks = result.tasks || [];
            emit();
        } catch (error) {
            if (version !== refreshVersion || projectId !== getProjectId()) return;
            message = error.message || '交接状态读取失败';
            emit();
        }
    };
    const perform = async work => {
        if (busy) return;
        if (!api) { message = '请重启 Corvas 后使用 Codex 交接。'; emit(); return; }
        busy = true; message = ''; emit();
        try { await work(); }
        catch (error) { message = error.message || '交接操作失败'; }
        finally { busy = false; emit(); }
    };
    return {
        refresh,
        create(instruction) {
            const text = String(instruction || '').trim();
            if (!text) { message = '请填写任务要求'; emit(); return Promise.resolve(); }
            return perform(async () => {
                const projectId = getProjectId();
                if (pendingRequest?.projectId !== projectId || pendingRequest?.instruction !== text) {
                    pendingRequest = { projectId, instruction: text, requestId: newRequestId() };
                }
                await onHandoff(text, pendingRequest.requestId);
                pendingRequest = null;
                message = '交接任务已创建';
                await refresh();
            });
        },
        copy(task) {
            return perform(async () => {
                await api.copy({ projectId: task.projectId, taskId: task.id });
                message = '交接指令已复制';
            });
        },
        open(task) {
            return perform(async () => {
                await api.open({ projectId: task.projectId, taskId: task.id });
            });
        },
        cancel(task) {
            return perform(async () => {
                await api.cancel({ projectId: task.projectId, taskId: task.id });
                await refresh();
            });
        }
    };
}

export function mountExternalHandoff({ root, target, getProjectId, onHandoff }) {
    const host = root.querySelector('[data-handoff]');
    const api = window.flowCanvas?.handoff;
    host.className = 'external-handoff';
    host.innerHTML = `<h3>Codex 交接</h3>
        <form class="external-handoff-form">
            <textarea rows="3" maxlength="6000" aria-label="Codex 任务要求" placeholder="任务要求"></textarea>
            <button type="submit" data-handoff-action="create">创建交接</button>
        </form>
        <p class="external-handoff-message" role="status" aria-live="polite"></p>
        <div class="external-handoff-list"></div>`;
    const form = host.querySelector('form');
    const input = host.querySelector('textarea');
    const message = host.querySelector('[role="status"]');
    const list = host.querySelector('.external-handoff-list');
    let timer;
    let projectId = getProjectId();
    const actionButton = (action, label, iconName, task) => {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.handoffAction = action;
        button.setAttribute('aria-label', label); button.title = label;
        button.innerHTML = `<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-${iconName}"></use></svg>`;
        button.addEventListener('click', () => { void controller[action](task); });
        return button;
    };
    const render = state => {
        message.textContent = state.message;
        list.replaceChildren();
        if (!state.tasks.length) {
            const empty = document.createElement('p'); empty.className = 'external-handoff-empty';
            empty.textContent = '暂无交接任务'; list.append(empty);
        }
        for (const task of state.tasks) {
            const row = document.createElement('article'); row.className = 'external-handoff-task';
            const head = document.createElement('div'); head.className = 'external-handoff-task-head';
            const status = document.createElement('strong'); status.textContent = handoffStatusLabel(task.status);
            const actions = document.createElement('div'); actions.className = 'external-handoff-task-actions';
            if (task.owner?.conversationUrl) actions.append(actionButton('open', '打开 Codex 对话', 'window', task));
            actions.append(actionButton('copy', '复制交接指令', 'copy', task));
            if (!TERMINAL_STATUSES.has(task.status)) actions.append(actionButton('cancel', '取消交接', 'close', task));
            head.append(status, actions);
            const instruction = document.createElement('p'); instruction.textContent = task.instruction;
            row.append(head, instruction);
            if (task.summary) { const summary = document.createElement('p'); summary.textContent = task.summary; row.append(summary); }
            if (task.referenceIssues?.length) {
                const warning = document.createElement('p'); warning.className = 'external-handoff-warning';
                warning.textContent = `${task.referenceIssues.length} 个参考素材需要处理`; row.append(warning);
            }
            list.append(row);
        }
        host.querySelectorAll('button, textarea').forEach(element => { element.disabled = state.busy || !api; });
    };
    const controller = createHandoffController({ api, target, getProjectId, onHandoff, onChange: render });
    const refresh = () => {
        if (projectId !== getProjectId()) { projectId = getProjectId(); input.value = ''; render({ tasks: [], busy: false, message: '' }); }
        return controller.refresh();
    };
    form.addEventListener('submit', event => { event.preventDefault(); void controller.create(input.value); });
    render({ tasks: [], busy: false, message: api ? '' : '请重启 Corvas 后使用 Codex 交接。' });
    return {
        create: instruction => controller.create(instruction),
        focus() { input.focus(); },
        setVisible(visible) {
            clearInterval(timer);
            if (visible) { void refresh(); timer = setInterval(() => { void refresh(); }, 3000); }
        },
        dispose() { clearInterval(timer); }
    };
}
