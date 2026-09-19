const { ipcRenderer } = require('electron');

// No API is exposed to the website. Only trusted clicks in this isolated-world UI
// can acknowledge a job; downloads, paths and Rhino commands stay in the main process.
if (location.origin === 'https://3d.hunyuan.tencent.com' && process.isMainFrame) {
    let state = { jobs: [], mode: 'ask' };
    let root;
    const render = () => {
        if (!document.body) return;
        if (!root?.host.isConnected) {
            const host = document.createElement('div');
            host.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);width:min(560px,calc(100vw - 32px));z-index:2147483647;pointer-events:none';
            document.body.append(host); root = host.attachShadow({ mode: 'closed' });
        }
        root.replaceChildren();
        const style = document.createElement('style');
        style.textContent = 'section{box-sizing:border-box;font:13px/1.5 system-ui;color:#f4f4f5;background:#26282dee;border:1px solid #50525a;border-radius:12px;padding:12px 16px;margin-bottom:8px;box-shadow:0 8px 28px #0005;pointer-events:auto}strong{font-size:14px}p{margin:5px 0;color:#c7cad1}button{font:inherit;border:0;border-radius:7px;padding:6px 12px;margin:5px 8px 0 0;cursor:pointer;background:#43464f;color:#fff}button.primary{background:#466cf7}small{color:#aeb4c2}';
        root.append(style);
        const labels = { awaiting_confirmation: '模型已生成，发送到 Rhino 并整理？', queued: '等待发送到 Rhino', downloading: '正在下载模型',
            connecting: '正在连接 Rhino', importing: '正在导入 Rhino', processing: 'Rhino 正在整理模型', completed: 'Rhino 整理任务已结束，请查看结果',
            failed: '自动处理未完成', interrupted: '处理已暂停，请检查 Rhino 和 Agent 任务' };
        const jobs = (state.jobs || []).filter(job => !job.dismissed && labels[job.status]).slice(-3);
        for (const job of jobs) {
            const card = document.createElement('section'); card.setAttribute('role', 'status');
            const title = document.createElement('strong'); title.textContent = labels[job.status];
            const detail = document.createElement('p'); detail.textContent = job.error || '保留原模型，在副本上清理并整理四边面。';
            const mode = document.createElement('small'); mode.textContent = `Corvas · ${state.mode === 'auto' ? '自动' : '手动'}模式`;
            card.append(title, detail, mode, document.createElement('br'));
            const button = (label, action, primary = false) => {
                const element = document.createElement('button'); element.textContent = label; element.className = primary ? 'primary' : '';
                element.addEventListener('click', event => {
                    if (!event.isTrusted) return;
                    element.disabled = true;
                    ipcRenderer.send('hunyuan:workflow-action', { id: job.id, action });
                }); card.append(element);
            };
            if (job.status === 'awaiting_confirmation') button('确认发送并整理', 'confirm', true);
            if (job.status === 'failed' && !job.runId && !job.importStarted) button('重试', 'confirm', true);
            if (['awaiting_confirmation', 'completed', 'failed', 'interrupted'].includes(job.status)) button(job.status === 'awaiting_confirmation'
                ? '暂不处理' : job.status === 'interrupted' ? '已检查，继续队列' : '收起', 'dismiss');
            root.append(card);
        }
        if (state.error && !jobs.length) {
            const note = document.createElement('section'); note.textContent = `Corvas：${state.error}`; root.append(note);
        }
    };
    ipcRenderer.on('hunyuan:workflow-state', (_event, next) => { state = next; render(); });
    window.addEventListener('DOMContentLoaded', () => { render(); ipcRenderer.send('hunyuan:workflow-ready'); });
}
