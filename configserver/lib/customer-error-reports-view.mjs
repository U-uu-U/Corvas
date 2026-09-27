export const CUSTOMER_REPORT_STYLE = `
.customer-reports { border-top:1px solid #30353e; padding-top:20px; }
.customer-report-filters { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.customer-report-filters input { flex:1 1 250px; min-width:0; }
.customer-report-filters select,.customer-report-detail select { background:#13161c; color:inherit; border:1px solid #383e49; padding:8px; border-radius:6px; max-width:100%; }
.customer-report-toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.customer-report-toolbar button,.customer-report-toolbar a { display:inline-flex; gap:6px; align-items:center; }
.customer-report-list { overflow-x:auto; margin:10px 0; }
.customer-report-list table { min-width:740px; }
.customer-report-list td:nth-child(4) { white-space:normal; min-width:180px; max-width:400px; overflow-wrap:anywhere; }
.customer-report-list tr[aria-selected=true] { background:#183b32; }
.customer-report-detail { border-top:1px solid #30353e; padding-top:18px; margin-top:16px; min-width:0; }
.customer-report-detail h3 { font-size:14px; margin:16px 0 8px; }
.customer-report-detail pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:480px; overflow:auto; margin:8px 0 14px; }
.customer-report-detail dl { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:6px 16px; overflow-wrap:anywhere; }
.customer-report-detail dd { margin:0; }
.customer-report-detail textarea { min-height:96px; font:inherit; }
.customer-report-note { color:#b3bac4; font-size:12px; }
.customer-report-detail[hidden] { display:none; }
@media(max-width:600px) { .customer-report-filters { align-items:stretch; } .customer-report-filters input { flex-basis:100%; } .customer-report-detail dl { grid-template-columns:1fr; gap:2px; } .customer-report-detail dd { margin-bottom:8px; } }
`;

const icon = name => `<svg width="15" height="15" aria-hidden="true"><use href="/admin/assets/flow-icons.svg#icon-${name}"></use></svg>`;

export function customerReportsMarkup() {
    return `<section id="customerErrorReports" class="customer-reports">
    <h2>客户错误提交</h2>
    <form id="customerReportFilters" class="customer-report-filters">
      <select name="status" aria-label="错误提交状态"><option value="">全部状态</option><option value="new">待处理</option><option value="investigating">处理中</option><option value="resolved">已解决</option></select>
      <input name="q" type="text" maxlength="200" placeholder="搜索编号、模型、描述或联系方式" aria-label="搜索错误提交">
      <button type="submit">${icon('search')} 查询</button>
      <button type="button" id="customerReportsRefresh" title="刷新错误提交列表" aria-label="刷新错误提交列表">${icon('history')}</button>
    </form>
    <p id="customerReportsStatus" role="status"></p>
    <div class="customer-report-list"><table><thead><tr><th>收到时间</th><th>状态</th><th>模型 / 站点</th><th>问题描述</th><th>操作</th></tr></thead><tbody id="customerReportRows"></tbody></table></div>
    <div class="customer-report-toolbar"><button type="button" id="customerReportsPrevious">上一页</button><span id="customerReportsPage" class="muted"></span><button type="button" id="customerReportsNext">下一页</button></div>
    <div id="customerReportDetail" class="customer-report-detail" hidden>
      <div class="customer-report-toolbar"><h3 id="customerReportTitle"></h3><a id="customerReportDownload">${icon('download')} 下载脱敏 JSON</a><button type="button" id="customerReportRefreshEvidence">${icon('history')} 补查服务端记录</button></div>
      <dl id="customerReportSummary"></dl>
      <h3>客户描述</h3><pre id="customerReportDescription"></pre>
      <h3>客户端诊断</h3><p class="customer-report-note">客户端上传，未经服务端核实。</p><pre id="customerReportClient"></pre>
      <h3>关联服务端记录</h3><p id="customerReportEvidenceState"></p><pre id="customerReportEvidence"></pre>
      <p class="customer-report-note">是否扣费或退款以账务记录为准，缺少记录不代表未扣费。</p>
      <form id="customerReportEdit"><div class="customer-report-toolbar"><label>处理状态 <select name="status" aria-label="处理状态"><option value="new">待处理</option><option value="investigating">处理中</option><option value="resolved">已解决</option></select></label><button type="submit">${icon('check')} 保存处理记录</button></div><label for="customerReportNote">管理员备注</label><textarea id="customerReportNote" name="adminNote" maxlength="10000"></textarea></form>
      <p id="customerReportActionStatus" role="status"></p>
    </div>
  </section>`;
}
