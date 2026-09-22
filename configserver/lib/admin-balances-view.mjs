export const BALANCE_STYLE = `
.balance-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:10px; }
.balance-toolbar h2 { margin:0; flex:1; }
.balance-toolbar button { width:34px; height:34px; padding:7px; display:grid; place-items:center; }
.balance-toolbar svg { width:18px; height:18px; fill:currentColor; }
.balance-table td { vertical-align:top; }
.balance-table td:first-child { min-width:155px; }
.balance-table small { display:block; color:#969ca7; font-size:11px; white-space:normal; max-width:240px; }
.balance-table .balance-amount { font-variant-numeric:tabular-nums; }
.balance-table tr[data-low=true] { background:#38272b; }
.balance-table tr[data-low=true] .balance-amount { color:#efb4b4; }
.balance-table input[type=number] { min-width:0; width:92px; border:1px solid #45484d; border-radius:4px; padding:5px; font:inherit; }
.balance-message { font-size:12px; color:#b3b8c2; margin:8px 0; }
.balance-table .balance-status { white-space:normal; min-width:145px; max-width:250px; }
`;

export function balancesMarkup() {
    return `<section id="balanceSection" aria-labelledby="balanceTitle">
      <div class="balance-toolbar"><h2 id="balanceTitle">上游余额</h2>
        <span id="balanceState" class="muted" role="status">读取中</span>
        <button id="refreshBalancesBtn" type="button" aria-label="刷新余额" title="刷新余额"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/admin/assets/flow-icons.svg#icon-history"></use></svg></button>
      </div>
      <div class="table-scroll"><table class="balance-table"><thead><tr>
        <th>上游 / 账号</th><th>可用余额</th><th>低余额预警线</th><th>查询状态</th><th>更新于</th><th>账户入口</th>
      </tr></thead><tbody id="balanceRows"><tr><td colspan="6">读取中</td></tr></tbody></table></div>
      <p id="balanceMessage" class="balance-message" role="status"></p>
    </section>`;
}
