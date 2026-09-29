/* global document */
const form = document.getElementById('requestDiagnosticsForm');
if (form) {
    const result = document.getElementById('requestDiagnosticsResult');
    const status = document.getElementById('requestDiagnosticsStatus');
    const summary = document.getElementById('requestDiagnosticsSummary');
    const errorText = document.getElementById('requestDiagnosticsError');
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('button');
        button.disabled = true;
        status.textContent = '正在查询';
        result.textContent = '';
        summary.replaceChildren();
        errorText.textContent = '';
        try {
            const search = new URLSearchParams({ site: form.elements.site.value, requestId: form.elements.requestId.value.trim() });
            const response = await fetch(`/admin/request-diagnostics?${search}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '查询失败');
            status.textContent = '查询完成';
            const envelope = data.record;
            const record = envelope.record || envelope.records?.[0] || (envelope.publicError ? envelope : {});
            const ledger = envelope.relayLog?.rows?.[0] || {};
            const stages = { validate: '参数校验', upload: '素材上传', submit: '提交任务', poll: '查询任务', download: '下载产物' };
            const states = { not_submitted: '未提交', rejected: '已拒绝', accepted: '已受理', unknown: '受理结果未知' };
            const values = [['排查编号', data.requestId || record.requestId], ['请求时间', record.createdAt || ledger.created_at],
                ['失败阶段', stages[record.publicError?.stage] || '未知'], ['HTTP状态', record.upstreamStatus || ledger.http_status || ledger.status_code],
                ['受理状态', states[record.publicError?.submissionState] || '未知'], ['模型', record.request?.model || ledger.model || ledger.model_name],
                ['实际参数', record.request ? JSON.stringify(record.request) : '未记录'],
                ['记录完整度', envelope.evidenceTruncated || envelope.recordsTruncated || envelope.relayLogLookupTruncated
                    ? '部分记录已截断，可分别按请求编号查询' : envelope.gatewayRecordMissing ? '仅找到中转站记录，缺少网关快照' : '已找到网关快照'],
                ['计费状态', '以账务记录为准；未查到记录不代表未扣费']];
            for (const [label, value] of values) {
                const term = document.createElement('dt'); term.textContent = label;
                const description = document.createElement('dd'); description.style.margin = '0'; description.textContent = value ?? '--';
                summary.append(term, description);
            }
            const audit = record.customerMessageAudit;
            errorText.textContent = `服务返回原因（凭据已脱敏）\n${JSON.stringify(record.classificationError || record.error || ledger.original_response_error || ledger.error_message || {}, null, 2)}\n\n客户具体原因\n${record.publicError?.customerMessage || record.publicError?.message || '旧记录未保存客户文案'}\n\n脱敏处理\n${audit ? JSON.stringify(audit, null, 2) : '旧记录没有转换审计，不能据此还原当时的客户显示'}`;
            result.textContent = JSON.stringify(data.record, null, 2);
        } catch (error) {
            status.textContent = error.message || '诊断服务暂不可用';
        } finally { button.disabled = false; }
    });
    document.getElementById('requestDiagnosticsReview')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        const list = document.getElementById('requestDiagnosticsReviewList');
        button.disabled = true; list.textContent = '正在读取';
        try {
            const response = await fetch(`/admin/request-diagnostics?${new URLSearchParams({ site: form.elements.site.value, review: '1' })}`, { credentials: 'same-origin', cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '读取失败');
            list.replaceChildren();
            for (const record of data.record?.records || []) {
                const row = document.createElement('button'); row.type = 'button';
                row.textContent = `${record.createdAt} · ${record.code} · ${record.requestId}`;
                row.addEventListener('click', () => { form.elements.requestId.value = record.requestId; form.requestSubmit(); });
                list.append(row);
            }
            if (!list.childElementCount) list.textContent = '暂无待适配错误';
        } catch (error) { list.textContent = error.message || '读取失败'; }
        finally { button.disabled = false; }
    });
}
