import './diagnostics-settings.css';

function createReportDialog(api) {
    const dialog = document.createElement('dialog');
    dialog.id = 'diagnosticsReportDialog';
    dialog.setAttribute('aria-labelledby', 'diagnosticsReportTitle');
    dialog.innerHTML = `<form class="diagnostics-report-form">
        <div class="diagnostics-report-heading"><h2 id="diagnosticsReportTitle">提交错误</h2>
            <button type="button" data-report-close title="关闭" aria-label="关闭"><svg class="flow-icon flow-icon-sm"><use href="./icons/flow-icons.svg#icon-close"></use></svg></button></div>
        <label>错误记录<select name="errorRecord" aria-label="错误记录"></select></label>
        <div class="diagnostics-report-context"></div>
        <label>使用站点<select name="site" aria-label="使用站点"><option value="unknown">未识别 / 其他</option><option value="art">art.ravenhash.org</option><option value="cart">cart.ravenhash.org</option></select></label>
        <label>问题说明<textarea name="description" maxlength="4000" rows="4" placeholder="发生问题时的操作和预期结果"></textarea></label>
        <label>联系方式（选填）<input name="contact" maxlength="200" autocomplete="off" placeholder="邮箱、微信或其他联系方式"></label>
        <p class="diagnostics-report-disclosure">包含错误记录、任务参数和客户端环境；密钥、提示词和素材内容会被隐藏。</p>
        <div class="diagnostics-report-status" role="status" aria-live="polite"></div>
        <div class="diagnostics-report-receipt" hidden><code></code><button type="button" data-report-copy title="复制反馈编号" aria-label="复制反馈编号"><svg class="flow-icon flow-icon-sm"><use href="./icons/flow-icons.svg#icon-copy"></use></svg></button></div>
        <div class="diagnostics-report-footer"><button type="submit" data-report-submit><svg class="flow-icon flow-icon-sm"><use href="./icons/flow-icons.svg#icon-arrow-up"></use></svg><span>提交错误</span></button></div>
    </form>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    const choice = form.elements.errorRecord;
    const site = form.elements.site;
    const description = form.elements.description;
    const contact = form.elements.contact;
    const status = dialog.querySelector('[role=status]');
    const submit = dialog.querySelector('[data-report-submit]');
    const receipt = dialog.querySelector('.diagnostics-report-receipt');
    const drafts = new Map();
    let draft;
    let records = [];
    let loading = 0;
    const siteValue = value => ['art', 'cart'].includes(value) ? value : 'unknown';
    const contextKey = context => context?.requestId ? `request:${context.requestId}`
        : context?.clientTaskId ? `client:${context.clientTaskId}` : context?.taskId ? `task:${context.taskId}`
            : context?.reportSubmissionId ? `submission:${context.reportSubmissionId}`
                : context?.time ? `event:${context.time}:${context.event || ''}` : 'general';
    const matches = (left, right) => {
        for (const key of ['requestId', 'clientTaskId', 'taskId']) {
            if (left?.[key] && right?.[key]) return left[key] === right[key];
        }
        return false;
    };
    const findDraft = context => drafts.get(contextKey(context)) || [...drafts.values()].find(entry => matches(entry.context, context));
    const selectDraft = context => {
        const key = contextKey(context);
        let selected = findDraft(context);
        if (!selected || (key === 'general' && selected.receipt)) {
            selected = { key, submissionId: crypto.randomUUID(), context, description: '', contact: '',
                site: siteValue(context.site), siteOverride: false };
            drafts.set(key, selected);
        } else if (!selected.input) {
            selected.context = { ...selected.context, ...context };
            if (!selected.siteOverride) selected.site = siteValue(selected.context.site);
        }
        return selected;
    };

    const saveDraft = () => {
        if (!draft || draft.input) return;
        draft.description = description.value;
        draft.contact = contact.value;
        draft.site = site.value;
    };
    const updateContext = () => {
        const context = draft?.context || {};
        dialog.querySelector('.diagnostics-report-context').textContent = [
            context.model,
            context.error || context.code,
            context.requestId ? `排查编号：${context.requestId}` : context.clientTaskId ? `任务：${context.clientTaskId}` : '',
        ].filter(Boolean).join('\n') || '未选择具体错误，将提交最近的诊断记录。';
    };
    const renderState = () => {
        const locked = Boolean(draft.input);
        for (const element of [choice, site, description, contact]) element.disabled = locked || draft.pending;
        submit.disabled = Boolean(draft.pending || draft.receipt);
        submit.querySelector('span').textContent = draft.pending ? '正在提交…' : draft.receipt ? '已提交' : locked ? '重试提交' : '提交错误';
        status.textContent = draft.status || '';
        status.classList.toggle('is-error', Boolean(draft.failed));
        receipt.hidden = !draft.receipt;
        receipt.querySelector('code').textContent = draft.receipt?.reportId || '';
    };
    const renderDraft = () => {
        description.value = draft.description;
        contact.value = draft.contact;
        site.value = draft.site;
        updateContext(); renderState();
    };
    choice.addEventListener('change', () => {
        saveDraft();
        draft = selectDraft(records[Number(choice.value)] || {});
        renderDraft();
    });
    form.addEventListener('input', event => {
        if (event.target === site && !draft.input) draft.siteOverride = true;
        saveDraft();
    });
    dialog.querySelector('[data-report-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', saveDraft);
    dialog.querySelector('[data-report-copy]').addEventListener('click', async () => {
        try {
            await window.flowCanvas.clipboard.writeText(draft.receipt.reportId);
            draft.status = '反馈编号已复制。';
        } catch { draft.status = '复制失败，请选择编号复制。'; }
        renderState();
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!draft || draft.pending || draft.receipt) return;
        saveDraft();
        if (!draft.input) draft.input = { submissionId: draft.submissionId, description: draft.description,
            contact: draft.contact, site: draft.site, requestId: draft.context?.requestId, context: draft.context };
        const submitting = draft;
        submitting.pending = true;
        submitting.failed = false;
        submitting.status = '正在提交错误报告…';
        renderState();
        try {
            submitting.receipt = await api.submit(submitting.input);
            submitting.status = '错误报告已收到，请保留反馈编号。';
        } catch (error) {
            submitting.failed = true;
            submitting.status = String(error.message || '提交暂未完成，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
        } finally {
            submitting.pending = false;
            if (draft === submitting) renderState();
        }
    });
    return async context => {
        saveDraft();
        const currentLoad = ++loading;
        draft = selectDraft(context || {});
        records = [draft.context];
        choice.replaceChildren(new Option('当前错误', '0'));
        renderDraft();
        if (!dialog.open) dialog.showModal();
        if (draft.input) return;
        submit.disabled = true;
        try {
            const data = await api.summary();
            if (loading !== currentLoad) return;
            for (const saved of data.submissions || []) {
                const savedContext = { ...saved.context, requestId: saved.requestId || saved.context?.requestId,
                    site: saved.site, reportSubmissionId: saved.submissionId };
                const key = contextKey(savedContext);
                const existing = findDraft(savedContext);
                if (existing?.input) continue;
                const recovered = { key, submissionId: saved.submissionId, context: savedContext,
                    description: saved.description || '', contact: saved.contact || '', site: siteValue(saved.site),
                    siteOverride: true, receipt: saved.receipt,
                    status: saved.receipt ? '错误报告已收到，请保留反馈编号。' : '有一份提交结果尚未确认的报告，可继续重试。',
                    input: { submissionId: saved.submissionId } };
                drafts.set(key, recovered);
            }
            draft = selectDraft(context || {});
            if (!context && !draft.input) {
                const unfinished = [...drafts.values()].find(entry => entry.input && !entry.receipt
                    && !entry.context.requestId && !entry.context.clientTaskId && !entry.context.taskId);
                if (unfinished) draft = unfinished;
            }
            const errors = data.reportErrors || [];
            const match = [...errors, ...(data.tasks || [])].find(entry =>
                (context?.requestId && entry.requestId === context.requestId)
                || (context?.clientTaskId && entry.clientTaskId === context.clientTaskId)
                || (context?.taskId && entry.taskId === context.taskId));
            const supplied = Object.fromEntries(Object.entries(context || {}).filter(([, value]) => value !== undefined && value !== null && value !== ''));
            const selected = { ...draft.context, ...(match || {}), ...supplied };
            if (selected.site === 'unknown' && match?.site) selected.site = match.site;
            const recoveredContexts = [...drafts.values()].filter(entry => entry.input).map(entry => entry.context);
            records = [selected, ...recoveredContexts, ...errors.filter(entry => entry !== match)]
                .filter((entry, index, entries) => entries.findIndex(other => contextKey(other) === contextKey(entry)) === index);
            choice.replaceChildren(...records.map((entry, index) => new Option(index === 0 ? (context ? '当前任务错误' : '最近诊断记录')
                : `${entry.time?.slice(11, 19) || ''} ${entry.model || entry.event || ''} ${entry.error || entry.code || ''}`.trim().slice(0, 110), String(index))));
            if (!draft.input) {
                draft.context = selected;
                if (!draft.siteOverride) draft.site = siteValue(selected.site);
            }
            if (data.storageError) draft.status = data.storageError;
            renderDraft();
        } catch {
            draft.status = '读取错误列表失败，仍可提交现有任务的诊断报告。';
        } finally {
            if (loading === currentLoad) renderState();
        }
    };
}

function mountDiagnostics() {
    const host = document.getElementById('agentApiDiagnostics');
    const api = window.flowCanvas?.diagnostics;
    if (!host || !api || document.getElementById('diagnosticsSettings')) return;
    const openReport = createReportDialog(api);
    document.addEventListener('diagnostics:report', event => { openReport(event.detail).catch(() => {}); });
    const root = document.createElement('details');
    root.id = 'diagnosticsSettings';
    root.innerHTML = `<summary>诊断日志</summary>
        <div class="diagnostics-actions">
            <span class="diagnostics-environment"></span>
            <button type="button" data-debug="refresh" title="刷新日志" aria-label="刷新日志"><svg class="flow-icon flow-icon-sm"><use href="./icons/flow-icons.svg#icon-replace"></use></svg></button>
            <button type="button" data-debug="copy" title="复制诊断摘要" aria-label="复制诊断摘要"><svg class="flow-icon flow-icon-sm"><use href="./icons/flow-icons.svg#icon-copy"></use></svg></button>
            <button type="button" data-debug="export" title="导出诊断报告" aria-label="导出诊断报告"><svg class="flow-icon flow-icon-sm"><use href="./icons/flow-icons.svg#icon-download"></use></svg></button>
            <button type="button" data-debug="submit" class="diagnostics-submit-button"><svg class="flow-icon flow-icon-sm"><use href="./icons/flow-icons.svg#icon-arrow-up"></use></svg><span>提交错误</span></button>
        </div><div class="diagnostics-status" role="status"></div><pre class="diagnostics-errors"></pre>`;
    host.append(root);
    const status = root.querySelector('[role=status]');
    const refresh = async () => {
        const data = await api.summary();
        root.querySelector('.diagnostics-environment').textContent = `v${data.version} · ${data.platform} ${data.arch}`;
        status.textContent = data.writeError ? `日志写入失败：${data.writeError}`
            : `${data.eventCount} 条记录${data.droppedEvents ? `，${data.droppedEvents} 条未记录` : ''}`;
        root.querySelector('pre').textContent = data.errors.length ? data.errors.map(entry =>
            `${entry.time}  ${entry.event}\n${JSON.stringify(entry.data, null, 2)}`).join('\n\n') : '暂无错误记录';
    };
    root.addEventListener('toggle', () => { if (root.open) refresh().catch(error => { status.textContent = error.message; }); });
    root.addEventListener('click', async event => {
        const button = event.target.closest('[data-debug]');
        if (!button || button.disabled) return;
        button.disabled = true;
        try {
            if (button.dataset.debug === 'refresh') await refresh();
            else if (button.dataset.debug === 'submit') await openReport();
            else {
                const result = await api[button.dataset.debug]();
                if (!result.canceled) status.textContent = button.dataset.debug === 'copy' ? '诊断摘要已复制' : '诊断报告已导出';
            }
        } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
    });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountDiagnostics, { once: true });
else mountDiagnostics();
