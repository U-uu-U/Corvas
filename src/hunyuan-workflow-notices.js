export function createHunyuanWorkflowNotices() {
    const api = window.flowCanvas?.hunyuan;
    if (!api?.workflowState) return;
    const root = document.createElement('aside');
    root.setAttribute('aria-label', '混元模型传递');
    Object.assign(root.style, { position: 'fixed', top: '48px', left: '50%', transform: 'translateX(-50%)',
        width: 'min(480px, calc(100vw - 32px))', zIndex: '12000', pointerEvents: 'none' });
    document.body.append(root);
    let revision = 0;
    const render = state => {
        revision++; root.replaceChildren();
        const labels = { awaiting_confirmation: '模型已生成，发送到 Rhino 并整理？', queued: '模型等待发送到 Rhino',
            waiting_rhino: '等待 Rhino / Cordyceps 连接',
            downloading: '正在下载混元模型', connecting: '正在连接 Rhino', importing: '正在导入 Rhino',
            processing: '正在执行 Rhino 整理 Skill', completed: 'Rhino 整理任务已结束，请查看结果', failed: '模型传递未完成', interrupted: '模型整理已暂停' };
        for (const job of (state.jobs || []).filter(job => !job.dismissed && labels[job.status]).slice(-2)) {
            const card = document.createElement('section'); card.setAttribute('role', 'status');
            card.style.cssText = 'pointer-events:auto;background:var(--bg-secondary,#26282d);color:var(--text-primary,#f4f4f5);border:1px solid var(--border-color,#50525a);border-radius:12px;padding:12px 16px;margin-bottom:8px;box-shadow:0 8px 24px #0004;font-size:13px';
            const title = document.createElement('strong'); title.textContent = labels[job.status];
            const text = document.createElement('p'); text.textContent = job.error || '保留原模型，在副本上清理并整理四边面。';
            text.style.cssText = 'margin:6px 0;opacity:.8'; card.append(title, text);
            const action = (label, name) => {
                const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
                button.style.cssText = 'padding:6px 10px;border-radius:6px;margin:4px 8px 0 0;cursor:pointer';
                button.addEventListener('click', async () => {
                    button.disabled = true;
                    try { render(await api.workflowAction({ id: job.id, action: name })); }
                    catch (error) { text.textContent = error.message; button.disabled = false; }
                }); card.append(button);
            };
            if (job.status === 'awaiting_confirmation') action('确认发送并整理', 'confirm');
            if (job.status === 'waiting_rhino') action('重试连接', 'confirm');
            if (job.status === 'failed' && !job.runId && !job.importStarted) action('重试', 'confirm');
            if (['awaiting_confirmation', 'waiting_rhino', 'completed', 'failed', 'interrupted'].includes(job.status)) action(['awaiting_confirmation', 'waiting_rhino'].includes(job.status)
                ? '暂不处理' : job.status === 'interrupted' ? '已检查，继续队列' : '收起', 'dismiss');
            root.append(card);
        }
    };
    const unsubscribe = api.onWorkflowChanged(render);
    const initialRevision = revision;
    void api.workflowState().then(state => { if (revision === initialRevision) render(state); }).catch(() => {});
    window.addEventListener('pagehide', () => { unsubscribe?.(); root.remove(); }, { once: true });
}
