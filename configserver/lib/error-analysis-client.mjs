/* global document, window */
const form = document.getElementById('errorAnalysisSettings');
if (form) {
    const status = document.getElementById('errorAnalysisStatus');
    const states = { pending: '待分析', running: '分析中', ready: '已验证', review: '待人工查看', failed: 'API 调用失败', no_evidence: '缺少有效错误信息' };
    async function request(body) {
        const response = await fetch('/admin/error-analysis', { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
            headers: body ? { 'content-type': 'application/json', 'x-csrf-token': document.querySelector('input[name="csrf"]')?.value || '' } : {},
            ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '读取失败');
        return data;
    }
    async function load(fill = false) {
        try {
            const data = await request();
            if (fill) {
                for (const key of ['endpoint', 'model', 'dailyLimit', 'protocol']) form.elements[key].value = data.settings[key];
                form.elements.enabled.checked = data.settings.enabled;
            }
            status.textContent = `${data.settings.enabled ? '自动分析已开启' : '自动分析已关闭'} · ${data.settings.hasKey ? 'Key 已保存' : '未配置 Key'} · 今日调用 ${data.settings.callsToday}/${data.settings.dailyLimit}`;
            document.getElementById('errorAnalysisRun').disabled = !data.settings.enabled;
            const rows = document.getElementById('errorAnalysisJobs'); rows.replaceChildren();
            for (const job of data.jobs) {
                const row = document.createElement('tr');
                for (const value of [job.site, states[job.status] || job.status, new Date(job.updatedAt).toLocaleString(), job.result ? `${job.result.cause}\n${job.result.suggestion}` : '--']) {
                    const cell = document.createElement('td'); cell.textContent = value; cell.style.overflowWrap = 'anywhere'; row.append(cell);
                }
                const action = document.createElement('td');
                if (['failed', 'review'].includes(job.status)) {
                    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试分析';
                    retry.addEventListener('click', async () => {
                        retry.disabled = true;
                        try { await request({ operation: 'retry', key: job.key }); await load(); }
                        catch (error) { status.textContent = error.message; retry.disabled = false; }
                    });
                    action.append(retry);
                }
                row.append(action);
                rows.append(row);
            }
        } catch (error) { status.textContent = error.message; }
    }
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]'); button.disabled = true;
        try {
            await request({ enabled: form.elements.enabled.checked, endpoint: form.elements.endpoint.value,
                model: form.elements.model.value, protocol: form.elements.protocol.value, apiKey: form.elements.apiKey.value, clearKey: form.elements.clearKey.checked,
                dailyLimit: Number(form.elements.dailyLimit.value) });
            form.elements.apiKey.value = ''; form.elements.clearKey.checked = false; await load(true);
        } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
    });
    document.getElementById('errorAnalysisRun').addEventListener('click', async () => {
        try { await request({ operation: 'run' }); status.textContent = '已开始检查'; } catch (error) { status.textContent = error.message; }
    });
    void load(true);
    const timer = setInterval(() => { void load(); }, 15000);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
