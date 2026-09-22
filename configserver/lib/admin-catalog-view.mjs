import { catalogGroups, catalogGroupKey, catalogModelCost, catalogModelPrices, catalogModelSource, catalogModelSummary, modelName, modelVisible } from './admin-catalog-model.mjs';
const sprite = '/admin/assets/flow-icons.svg';
const icon = (name, modifier = '') => `<svg class="catalog-icon ${modifier}" viewBox="0 0 24 24" aria-hidden="true"><use href="${sprite}#icon-${name}"></use></svg>`;

export const CATALOG_STYLE = `
.catalog-actions, .catalog-local-actions { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.catalog-actions { margin:0 0 14px; }
.catalog-mode { display:flex; align-items:center; gap:7px; color:#b5b8bf; font-size:12px; }
.catalog-mode select { min-width:120px; }
.catalog-actions .spacer { flex:1; }
.icon-command { width:34px; height:34px; flex:0 0 34px; padding:0; font:20px/1 sans-serif; display:inline-flex; align-items:center; justify-content:center; }
.catalog-actions button, .catalog-local-actions button { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
.catalog-icon { width:17px; height:17px; flex:0 0 17px; fill:currentColor; }
.catalog-icon.icon-right { transform:rotate(90deg); }
.catalog-icon.icon-down { transform:rotate(180deg); }
.catalog-icon.icon-mirror { transform:scaleX(-1); }
.group-order-command { padding:0 8px; font-size:12px; }
.catalog-actions button, .catalog-local-actions button { border-radius:6px; min-height:34px; }
.catalog-local-actions { padding:12px 0; border-bottom:1px solid #404144; margin-bottom:12px; }
.catalog-local-actions select { flex:1 1 160px; width:100%; min-width:0; }
.is-operation .editor-grid { grid-template-columns:minmax(420px,1.35fr) minmax(310px,1fr); }
.is-operation .model-browser { display:none; }
.catalog-pane { min-width:0; padding:18px 20px 20px 0; border-right:1px solid #404144; }
.catalog-filter { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 14px; }
.catalog-filter input[type=search] { flex:1 1 200px; width:100%; min-width:0; }
.catalog-filter select { flex:0 1 116px; }
.catalog-filter label { display:flex; align-items:center; gap:5px; font-size:12px; color:#b1b4b8; }
.catalog-preview { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); align-items:start; gap:8px; }
.catalog-groups, .catalog-models { min-width:0; display:flex; flex-direction:column; gap:6px; max-height:700px; overflow:auto; scrollbar-width:thin; }
.catalog-tile { position:relative; display:flex; flex-shrink:0; gap:10px; align-items:center; width:100%; min-height:70px; text-align:left; background:#292a2d; border:1px solid transparent; border-radius:7px; padding:12px; color:#d1d3d7; }
.catalog-tile .tile-copy { min-width:0; flex:1; }
.catalog-item { position:relative; min-width:0; flex-shrink:0; }
.catalog-item .catalog-tile { padding-top:40px; }
.catalog-call-control { position:absolute; right:10px; top:9px; display:flex; gap:7px; align-items:center; font-size:11px; color:#b9c2bb; }
.catalog-call-switch { position:relative; width:30px; height:18px; min-height:18px; border:1px solid #69717b; border-radius:9px; padding:0; background:#464a51; }
.catalog-call-switch::after { content:''; position:absolute; width:12px; height:12px; left:2px; top:2px; border-radius:50%; background:#dce1e5; }
.catalog-call-switch[aria-checked=true] { background:#397c61; border-color:#549b7c; }
.catalog-call-switch[aria-checked=true]::after { left:14px; background:#eff8f1; }
.catalog-call-switch:focus-visible { outline:2px solid #a3c8f0; outline-offset:3px; }
.catalog-tile strong, .catalog-tile small { display:block; overflow-wrap:anywhere; white-space:normal; }
.catalog-tile strong { font-size:13px; font-weight:600; line-height:1.5; }
.catalog-tile small { color:#93969d; font-size:11px; line-height:1.55; margin-top:3px; }
.catalog-tile:hover { background:#323438; }
.catalog-tile[aria-selected=true] { background:#36383d; border-color:#656971; }
.catalog-tile[data-hidden=true] { opacity:.55; }
.catalog-tile .tile-arrow { flex:0 0 14px; color:#bcc1c8; font-size:19px; }
.catalog-tile .tile-status { display:block; font-size:10px; color:#b7caad; margin-top:5px; }
.catalog-tile .tile-status.warning { color:#deb978; }
.catalog-price { display:block; margin-top:6px; color:#d6c58f; font-size:12px; line-height:1.5; font-variant-numeric:tabular-nums; white-space:normal; overflow-wrap:anywhere; }
.catalog-price + .catalog-price { margin-top:2px; }
.catalog-price[data-site="cart.ravenhash.org"] { color:#a7c8b7; }
.catalog-cost { display:block; margin-top:5px; color:#b3c5da; font-size:11px; line-height:1.55; white-space:normal; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.catalog-cost[data-status="historical"] { color:#c8b395; }
.catalog-cost[data-status="unknown"] { color:#9da3ad; }
.catalog-source { display:block; margin-top:3px; color:#a5a8ae; font-size:11px; line-height:1.55; white-space:normal; overflow-wrap:anywhere; }
.catalog-source-url { margin-top:1px; }
.catalog-tile[data-disabled=true] .tile-status { color:#a7aab0; }
.catalog-empty { grid-column:1/-1; padding:30px 12px; text-align:center; color:#92959b; font-size:13px; }
.catalog-pane h3 { font-size:12px; color:#a8aab1; margin:0 0 10px; font-weight:500; }
.catalog-selection { font-size:12px; color:#b5b8be; overflow-wrap:anywhere; margin:12px 0 0; }
.catalog-dialog { width:min(460px,calc(100vw - 32px)); background:#242629; color:#d6d8dc; border:1px solid #595c62; border-radius:8px; padding:22px; }
.catalog-dialog::backdrop { background:#0009; }
.catalog-dialog h3 { font-size:16px; margin:0 0 18px; }
.catalog-dialog fieldset { border:0; padding:0; margin:0; min-width:0; }
.catalog-dialog .field { margin-bottom:14px; }
.catalog-dialog .dialog-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:20px; }
.catalog-dialog .dialog-error { color:#e5a39e; white-space:pre-wrap; font-size:12px; }
.catalog-dialog p { font-size:13px; line-height:1.6; }
.is-operation .price-section { display:none; }
.is-operation .form-section { margin-top:16px; padding-top:16px; }
.is-operation .field-grid { gap:12px; }
.editor-tabs [aria-selected=true] { background:#37393d; color:#eef0f2; border-color:#62666d; }
.editor-grid, .model-browser, .form-section { border-color:#3c3e43; }
input[type=number], input[type=search], input[type=text], select, textarea { background:#202225; border-color:#45484d; color:#d8dade; }
@media(max-width:1100px) {
 .is-operation .editor-grid { grid-template-columns:minmax(0,1fr); }
 .catalog-pane { padding:16px 0; border-right:0; border-bottom:1px solid #404144; }
 .is-operation .model-details { padding:18px 0; }
 .catalog-groups,.catalog-models { max-height:500px; }
}
@media(max-width:520px) {
 .catalog-preview { grid-template-columns:minmax(0,1fr); }
 .catalog-groups { max-height:270px; }
 .catalog-models { max-height:310px; border-top:1px solid #4c4f55; padding-top:8px; }
 .catalog-tile { min-height:66px; padding:10px; }
 .catalog-actions .spacer { display:none; }
 .editor-toolbar { gap:10px; }
 .editor-tabs button { padding:8px 10px; }
}
`;

export function catalogActionsMarkup() {
    return `<div id="catalogActions" class="catalog-actions" hidden>
      <label class="catalog-mode"><span>目录来源</span><select id="catalogMode"><option value="remote">远程目录</option><option value="fallback">兼容目录</option></select></label>
      <button type="button" id="addModelBtn">${icon('plus')}新增模型</button>
      <button type="button" id="copyModelBtn" class="icon-command" title="复制模型" aria-label="复制模型">${icon('copy')}</button>
      <button type="button" id="deleteModelBtn" class="icon-command" title="删除模型" aria-label="删除模型">${icon('trash')}</button>
      <span class="spacer"></span>
      <button type="button" id="undoCatalogBtn" class="icon-command" title="撤销" aria-label="撤销">${icon('history')}</button>
      <button type="button" id="redoCatalogBtn" class="icon-command" title="重做" aria-label="重做">${icon('history', 'icon-mirror')}</button>
      <button type="button" id="clearCatalogBtn">${icon('trash')}清空目录</button>
    </div>`;
}

export function catalogPaneMarkup() {
    return `<section id="catalogPane" class="catalog-pane" hidden aria-label="模型目录操作">
      <div class="catalog-filter">
        <input id="catalogSearch" type="search" placeholder="搜索模型或 API" aria-label="搜索模型或 API">
        <select id="catalogKind" aria-label="目录类型"><option value="video">视频</option><option value="image">图片</option><option value="text">文字</option><option value="">全部类型</option></select>
        <label><input id="catalogShowHidden" type="checkbox">显示隐藏项</label>
        <label id="catalogShowLegacyLabel"><input id="catalogShowLegacy" type="checkbox">未纳入目录</label>
      </div>
      <div class="catalog-local-actions">
        <select id="catalogMoveGroup" aria-label="模型所属分组"></select>
        <button type="button" id="createGroupBtn">${icon('folder-add')}分组</button>
        <button type="button" id="renameGroupBtn">${icon('tag')}改组名</button>
      </div>
      <div class="catalog-preview"><div id="catalogGroups" class="catalog-groups" role="listbox" aria-label="模型与渠道组"></div>
        <div id="catalogModels" class="catalog-models" role="listbox" aria-label="组内模型"></div></div>
      <div class="catalog-local-actions">
        <button type="button" id="moveModelUpBtn" class="icon-command" title="模型上移" aria-label="模型上移">${icon('arrow-up')}</button>
        <button type="button" id="moveModelDownBtn" class="icon-command" title="模型下移" aria-label="模型下移">${icon('arrow-up', 'icon-down')}</button>
        <button type="button" id="moveGroupUpBtn" class="group-order-command" title="整个组上移" aria-label="整个组上移">${icon('arrow-up')}组</button>
        <button type="button" id="moveGroupDownBtn" class="group-order-command" title="整个组下移" aria-label="整个组下移">${icon('arrow-up', 'icon-down')}组</button>
        <label><input id="catalogVisible" type="checkbox">显示模型</label>
      </div>
      <div id="catalogSelection" class="catalog-selection"></div>
    </section>`;
}

export function catalogDialogMarkup() {
    return `<dialog id="catalogDialog" class="catalog-dialog" aria-labelledby="catalogDialogTitle">
      <h3 id="catalogDialogTitle"></h3><p id="catalogDialogMessage" hidden></p>
      <fieldset id="catalogDialogFields" disabled>
        <label class="field" data-dialog-row="label"><span id="catalogDialogLabelTitle">显示名称</span><input id="catalogDialogLabel" type="text" maxlength="100" autocomplete="off"></label>
        <label class="field" data-dialog-row="kind"><span>模型类型</span><select id="catalogDialogKind"><option value="video">视频</option><option value="image">图片</option><option value="text">文字</option></select></label>
        <label class="field" data-dialog-row="model"><span>模型 ID</span><input id="catalogDialogModel" type="text" maxlength="200" autocomplete="off" spellcheck="false"></label>
        <label class="field" data-dialog-row="hosts"><span>API 主机名</span><textarea id="catalogDialogHosts" rows="2" placeholder="art.ravenhash.org&#10;cart.ravenhash.org" spellcheck="false"></textarea></label>
      </fieldset>
      <p id="catalogDialogError" class="dialog-error" role="alert" hidden></p>
      <div class="dialog-actions"><button id="catalogDialogCancel" type="button">取消</button><button id="catalogDialogConfirm" type="button">确定</button></div>
    </dialog>`;
}

export function appendCatalogSource(document, parent, entry, sources) {
    const source = catalogModelSource(entry, sources);
    for (const key of ['name', 'url']) {
        const line = document.createElement('span');
        line.className = `catalog-source catalog-source-${key}`;
        line.textContent = source[key];
        parent.append(line);
    }
}

export function appendCatalogPrices(document, parent, entry, prices, costs) {
    for (const record of catalogModelPrices(entry, prices)) {
        const line = document.createElement('span');
        line.className = 'catalog-price';
        line.dataset.site = record.host;
        line.textContent = record.text;
        line.title = record.title;
        parent.append(line);
    }
    const cost = catalogModelCost(entry, costs);
    const line = document.createElement('span');
    line.className = 'catalog-cost';
    line.dataset.status = cost.status;
    line.textContent = cost.text;
    line.title = cost.title;
    parent.append(line);
}

function tile(document, entry, { label, detail, selected, arrow = false, hidden = false, disabled = false, status = '', warning = false, onClick, onToggle, sources, prices, costs }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'catalog-tile';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(selected));
    button.dataset.hidden = String(hidden);
    button.dataset.disabled = String(disabled);
    if (entry) button.dataset.catalogModelId = entry.id;
    const text = document.createElement('span');
    text.className = 'tile-copy';
    const title = document.createElement('strong');
    title.textContent = label;
    const small = document.createElement('small');
    small.textContent = detail;
    text.append(title, small);
    if (status) {
        const badge = document.createElement('span');
        badge.className = `tile-status${warning ? ' warning' : ''}`;
        badge.textContent = status;
        text.append(badge);
    }
    if (entry) {
        appendCatalogPrices(document, text, entry, prices, costs);
        appendCatalogSource(document, text, entry, sources);
    }
    button.append(text);
    if (arrow) {
        const arrowIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        arrowIcon.setAttribute('class', 'catalog-icon icon-right');
        arrowIcon.setAttribute('viewBox', '0 0 24 24');
        arrowIcon.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `${sprite}#icon-arrow-up`);
        arrowIcon.append(use);
        button.append(arrowIcon);
    }
    button.addEventListener('click', onClick);
    if (entry?.catalog && onToggle) {
        const wrapper = document.createElement('div');
        wrapper.className = 'catalog-item';
        const control = document.createElement('span');
        control.className = 'catalog-call-control';
        const text = document.createElement('span');
        text.textContent = '允许调用';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'catalog-call-switch';
        toggle.dataset.callModelId = entry.id;
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', String(!disabled));
        toggle.setAttribute('aria-label', `${modelName(entry)}允许调用`);
        toggle.title = disabled ? '启用调用' : '停用调用';
        toggle.addEventListener('click', () => onToggle(entry.id, disabled));
        control.append(text, toggle);
        wrapper.append(button, control);
        return wrapper;
    }
    return button;
}

export function renderCatalog(document, config, selectedId, onSelect, sources, prices, costs, onToggle) {
    document.getElementById('catalogMode').value = config.catalogMode === 'remote' ? 'remote' : 'fallback';
    const selected = config.models.find(entry => entry.id === selectedId);
    document.getElementById('catalogShowLegacyLabel').hidden = config.catalogMode !== 'remote';
    const groups = catalogGroups(config, { kind: document.getElementById('catalogKind').value,
        query: document.getElementById('catalogSearch').value, includeHidden: document.getElementById('catalogShowHidden').checked,
        includeDisabled: true,
        includeLegacy: config.catalogMode !== 'remote' || document.getElementById('catalogShowLegacy').checked });
    const groupList = document.getElementById('catalogGroups');
    const modelList = document.getElementById('catalogModels');
    const scroll = [groupList.scrollTop, modelList.scrollTop];
    groupList.replaceChildren();
    modelList.replaceChildren();
    const selectedGroup = groups.find(group => group.entries.some(entry => entry.id === selectedId));
    const renderEntry = entry => tile(document, entry, { label: modelName(entry),
        detail: [entry.presentation?.routeGroup ? entry.catalog?.model : '', catalogModelSummary(entry)].filter(Boolean).join(' · ')
            || entry.presentation?.description || entry.catalog?.model || entry.id,
        hidden: entry.presentation?.visible === false, disabled: entry.catalog?.enabled === false, selected: selectedId === entry.id,
        status: entry.catalog?.enabled === false ? '已停用' : entry.presentation?.visible === false ? '已隐藏'
            : !entry.catalog ? '待补全模型 ID 与 API 主机' : selectedId === entry.id ? '当前' : '',
        warning: !entry.catalog, onClick: () => onSelect(entry.id), onToggle, sources, prices, costs });
    for (const group of groups) {
        if (!group.id) groupList.append(renderEntry(group.entries[0]));
        else {
            const current = group.entries.find(entry => entry.id === selectedId && modelVisible(entry))
                || group.entries.find(modelVisible) || group.entries[0];
            const button = tile(document, null, { label: group.label,
                detail: group.disabled ? '分组停用' : `当前使用：${modelName(current)}`,
                status: !group.disabled && group.disabledCount ? `部分停用（${group.disabledCount}/${group.totalCount}）` : '',
                warning: !group.disabled && group.disabledCount > 0, disabled: group.disabled,
                selected: selectedGroup?.key === group.key, arrow: true,
                hidden: group.entries.every(entry => entry.presentation?.visible === false),
                onClick: () => onSelect(selectedGroup?.key === group.key ? selectedId : current.id) });
            button.dataset.catalogGroup = group.key;
            groupList.append(button);
        }
    }
    if (selectedGroup) selectedGroup.entries.forEach(entry => modelList.append(renderEntry(entry)));
    if (!groups.length) {
        const empty = document.createElement('p');
        empty.className = 'catalog-empty';
        empty.textContent = config.models.length ? '没有匹配的模型' : '目录为空';
        groupList.append(empty);
    }
    groupList.scrollTop = scroll[0];
    modelList.scrollTop = scroll[1];
    const move = document.getElementById('catalogMoveGroup');
    move.replaceChildren();
    const addOption = (value, label) => { const option = document.createElement('option'); option.value = value; option.textContent = label; move.append(option); };
    addOption('', '独立模型');
    catalogGroups(config, { kind: selected?.kind || '' }).filter(group => group.id).forEach(group => addOption(group.key, group.label));
    move.value = selected?.presentation?.routeGroup ? catalogGroupKey(selected) : '';
    move.disabled = !selected;
    const controls = ['copyModelBtn', 'deleteModelBtn', 'createGroupBtn', 'moveModelUpBtn', 'moveModelDownBtn', 'catalogVisible'];
    controls.forEach(id => { document.getElementById(id).disabled = !selected; });
    ['renameGroupBtn', 'moveGroupUpBtn', 'moveGroupDownBtn'].forEach(id => {
        document.getElementById(id).disabled = !selected?.presentation?.routeGroup;
    });
    document.getElementById('catalogVisible').checked = !!selected && selected.presentation?.visible !== false;
    document.getElementById('clearCatalogBtn').disabled = !config.models.length;
    document.getElementById('catalogSelection').textContent = selected
        ? `${modelName(selected)} · ${selected.catalog?.hosts?.join(' / ') || '未纳入托管目录'}` : '';
}
