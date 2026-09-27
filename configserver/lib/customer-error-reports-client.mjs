/* global document */
const root = document.getElementById('customerErrorReports');
if (root) {
    const element = id => document.getElementById(id);
    const filter = element('customerReportFilters');
    const edit = element('customerReportEdit');
    const statusNames = { new: '待处理', investigating: '处理中', resolved: '已解决' };
    const siteNames = { art: '老站', cart: '新站', unknown: '站点未知' };
    const evidenceNames = { pending: '等待补查', complete: '已关联服务端记录', partial: '部分记录已关联',
        unavailable: '暂未取得服务端记录', no_request_id: '无可关联的排查编号' };
    let offset = 0;
    let total = 0;
    let selected = '';
    let listSequence = 0;
    let detailSequence = 0;
    let listBusy = false;
    let detailBusy = false;
    const textNode = (tag, text) => { const node = document.createElement(tag); node.textContent = text ?? '--'; return node; };
    async function request(url, body) {
        const headers = { accept: 'application/json' };
        if (body) {
            headers['content-type'] = 'application/json';
            headers['x-csrf-token'] = document.querySelector('#configForm [name=csrf]').value;
        }
        const response = await fetch(url, { method: body ? 'POST' : 'GET', headers,
            credentials: 'same-origin', cache: 'no-store', ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '操作未完成');
        return data;
    }
    const localDate = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--';
    function setBusy() {
        element('customerReportsPrevious').disabled = listBusy || offset <= 0;
        element('customerReportsNext').disabled = listBusy || offset + 30 >= total;
        element('customerReportsRefresh').disabled = listBusy;
        element('customerReportRefreshEvidence').disabled = detailBusy || !selected;
        edit.querySelector('button').disabled = detailBusy || !selected;
    }
    function showReport(report) {
        selected = report.reportId;
        element('customerReportDetail').hidden = false;
        element('customerReportTitle').textContent = report.reportId;
        element('customerReportDownload').href = `/admin/error-reports/${report.reportId}?download=1`;
        element('customerReportDownload').download = `${report.reportId}.json`;
        const submission = report.submission;
        const summary = element('customerReportSummary');
        summary.replaceChildren();
        for (const [label, value] of [['收到时间', localDate(report.receivedAt)], ['联系方式', submission.contact || '未填写'],
            ['站点', siteNames[submission.site] || '未知'], ['排查编号', submission.requestId || '无'],
            ['处理状态', statusNames[report.status]], ['最近更新', localDate(report.updatedAt)]]) {
            summary.append(textNode('dt', label), textNode('dd', value));
        }
        element('customerReportDescription').textContent = submission.description || '未填写';
        element('customerReportClient').textContent = JSON.stringify({ context: submission.context, diagnostic: submission.diagnostic }, null, 2);
        element('customerReportEvidenceState').textContent = evidenceNames[report.serverEvidence?.state] || '未知';
        element('customerReportEvidence').textContent = JSON.stringify(report.serverEvidence, null, 2);
        edit.elements.status.value = report.status;
        edit.elements.adminNote.value = report.adminNote || '';
        for (const row of element('customerReportRows').children) row.setAttribute('aria-selected', String(row.dataset.id === selected));
    }
    async function loadDetail(id) {
        const sequence = ++detailSequence;
        selected = id;
        detailBusy = true;
        setBusy();
        element('customerReportActionStatus').textContent = '正在读取';
        try {
            const report = await request(`/admin/error-reports/${id}`);
            if (sequence !== detailSequence) return;
            showReport(report);
            element('customerReportActionStatus').textContent = '';
        } catch (error) {
            if (sequence === detailSequence) element('customerReportsStatus').textContent = error.message;
        } finally {
            if (sequence === detailSequence) { detailBusy = false; setBusy(); }
        }
    }
    async function loadList() {
        const sequence = ++listSequence;
        listBusy = true;
        setBusy();
        element('customerReportsStatus').textContent = '正在读取错误提交';
        try {
            const query = new URLSearchParams({ status: filter.elements.status.value, q: filter.elements.q.value, offset: String(offset) });
            const data = await request(`/admin/error-reports?${query}`);
            if (sequence !== listSequence) return;
            total = data.total;
            const rows = element('customerReportRows');
            rows.replaceChildren();
            for (const report of data.reports) {
                const row = document.createElement('tr'); row.dataset.id = report.reportId;
                row.setAttribute('aria-selected', String(report.reportId === selected));
                row.append(textNode('td', localDate(report.receivedAt)), textNode('td', statusNames[report.status]),
                    textNode('td', `${report.model || '--'} / ${siteNames[report.site] || '未知'}`), textNode('td', report.description || '未填写'));
                const cell = document.createElement('td');
                const button = textNode('button', '查看'); button.type = 'button';
                button.addEventListener('click', () => loadDetail(report.reportId));
                cell.append(button); row.append(cell); rows.append(row);
            }
            if (!data.reports.length) { const row = document.createElement('tr'); const cell = textNode('td', '暂无符合条件的错误提交'); cell.colSpan = 5; row.append(cell); rows.append(row); }
            element('customerReportsStatus').textContent = `待处理 ${data.counts.new} · 处理中 ${data.counts.investigating} · 已解决 ${data.counts.resolved} · 保留 ${data.retentionDays} 天`;
            element('customerReportsPage').textContent = total ? `${offset + 1}–${Math.min(offset + 30, total)} / ${total}` : '0 / 0';
        } catch (error) {
            if (sequence === listSequence) element('customerReportsStatus').textContent = error.message;
        } finally { if (sequence === listSequence) { listBusy = false; setBusy(); } }
    }
    async function mutate(operation, body) {
        if (!selected || detailBusy) return;
        const id = selected;
        const sequence = ++detailSequence;
        detailBusy = true; setBusy();
        element('customerReportActionStatus').textContent = operation === 'refresh' ? '正在补查服务端记录' : '正在保存';
        try {
            const report = await request(`/admin/error-reports/${id}/${operation}`, body);
            if (sequence !== detailSequence) return;
            showReport(report);
            element('customerReportActionStatus').textContent = operation === 'refresh' ? '补查完成' : '已保存';
            await loadList();
        } catch (error) {
            if (sequence === detailSequence) element('customerReportActionStatus').textContent = error.message;
        } finally { if (sequence === detailSequence) { detailBusy = false; setBusy(); } }
    }
    filter.addEventListener('submit', event => { event.preventDefault(); offset = 0; loadList(); });
    filter.elements.status.addEventListener('change', () => { offset = 0; loadList(); });
    element('customerReportsRefresh').addEventListener('click', () => loadList());
    element('customerReportsPrevious').addEventListener('click', () => { offset = Math.max(0, offset - 30); loadList(); });
    element('customerReportsNext').addEventListener('click', () => { offset += 30; loadList(); });
    element('customerReportRefreshEvidence').addEventListener('click', () => mutate('refresh', {}));
    edit.addEventListener('submit', event => { event.preventDefault(); mutate('status', { status: edit.elements.status.value, adminNote: edit.elements.adminNote.value }); });
    loadList();
}
