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
.catalog-icon.icon-left { transform:rotate(-90deg); }
.catalog-icon.icon-down { transform:rotate(180deg); }
.catalog-icon.icon-mirror { transform:scaleX(-1); }
.group-order-command { padding:0 8px; font-size:12px; }
.catalog-actions button, .catalog-local-actions button { border-radius:6px; min-height:34px; }
.catalog-local-actions { padding:12px 0; border-bottom:1px solid #404144; margin-bottom:12px; }
.catalog-local-actions select { flex:1 1 160px; width:100%; min-width:0; }
.is-operation .editor-grid { grid-template-columns:minmax(0,1fr); }
.is-operation .model-browser { display:none; }
.is-operation .model-details { display:none; }
.catalog-pane { min-width:0; padding:18px 0 20px; }
.catalog-filter { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 14px; }
.catalog-filter input[type=search] { flex:1 1 200px; width:100%; min-width:0; }
.catalog-filter select { flex:0 1 116px; }
.catalog-filter label { display:flex; align-items:center; gap:5px; font-size:12px; color:#b1b4b8; }
.catalog-preview { display:grid; grid-template-columns:minmax(180px,.7fr) minmax(0,1fr) minmax(0,1fr); align-items:start; gap:16px; }
.catalog-column { min-width:0; }
.catalog-column + .catalog-column { border-left:1px solid #404144; padding-left:16px; }
.catalog-column-heading { display:flex; justify-content:space-between; gap:8px; min-height:30px; align-items:start; }
.catalog-column-heading h3 { overflow-wrap:anywhere; }
.catalog-count { color:#93969d; font-size:12px; font-variant-numeric:tabular-nums; }
.catalog-groups, .catalog-models { min-width:0; display:flex; flex-direction:column; gap:6px; min-height:180px; max-height:700px; overflow:auto; scrollbar-width:thin; }
.catalog-model-actions { display:flex; justify-content:flex-end; gap:5px; padding:6px 0 2px; }
.catalog-model-actions button { width:30px; height:28px; padding:0; display:inline-flex; align-items:center; justify-content:center; }
.catalog-tile[draggable=true] { cursor:grab; }
.catalog-tile.is-dragging { opacity:.45; }
[data-drop-group].is-drop-target { outline:2px solid #75b69b; outline-offset:-2px; background:#2a3631; }
[data-drop-group].is-drop-target[data-drop-position] { outline:0; background:transparent; }
[data-drop-position]::before { content:''; position:absolute; left:0; right:0; height:3px; background:#91d1b4; z-index:3; pointer-events:none; }
[data-drop-position=before]::before { top:0; }
[data-drop-position=after]::before { bottom:0; }
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
@media(max-width:900px) {
 .is-operation .editor-grid { grid-template-columns:minmax(0,1fr); }
 .catalog-pane { padding:16px 0; border-right:0; border-bottom:1px solid #404144; }
 .is-operation .model-details { padding:18px 0; }
 .catalog-groups,.catalog-models { max-height:500px; }
 .catalog-preview { grid-template-columns:minmax(150px,.65fr) minmax(0,1fr); }
 .catalog-unassigned-column { grid-column:1/-1; border-top:1px solid #404144; padding-top:16px; }
 .catalog-column.catalog-unassigned-column { border-left:0; padding-left:0; }
 #catalogUngrouped { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-content:start; }
}
@media(max-width:520px) {
 .catalog-preview { grid-template-columns:minmax(0,1fr); }
 .catalog-column + .catalog-column { border-left:0; padding-left:0; }
 .catalog-unassigned-column { grid-column:auto; }
 #catalogUngrouped { display:flex; }
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
        <button type="button" id="createGroupBtn">${icon('folder-add')}新增分组</button>
        <button type="button" id="renameGroupBtn" class="icon-command" title="修改分组名" aria-label="修改分组名">${icon('tag')}</button>
        <button type="button" id="deleteGroupBtn" class="icon-command" title="删除分组" aria-label="删除分组">${icon('trash')}</button>
        <button type="button" id="moveGroupUpBtn" class="icon-command" title="分组上移" aria-label="分组上移">${icon('arrow-up')}</button>
        <button type="button" id="moveGroupDownBtn" class="icon-command" title="分组下移" aria-label="分组下移">${icon('arrow-up', 'icon-down')}</button>
      </div>
      <div class="catalog-preview">
        <section class="catalog-column"><div class="catalog-column-heading"><h3>渠道分组</h3><span id="catalogGroupCount" class="catalog-count"></span></div>
          <div id="catalogGroups" class="catalog-groups" role="listbox" aria-label="渠道分组"></div></section>
        <section class="catalog-column"><div class="catalog-column-heading"><h3 id="catalogModelsTitle">组内模型</h3><span id="catalogMemberCount" class="catalog-count"></span></div>
          <div id="catalogModels" class="catalog-models" role="listbox" aria-label="组内模型"></div></section>
        <section class="catalog-column catalog-unassigned-column"><div class="catalog-column-heading"><h3>未分组模型</h3><span id="catalogUngroupedCount" class="catalog-count"></span></div>
          <div id="catalogUngrouped" class="catalog-models" role="listbox" aria-label="未分组模型"></div></section>
      </div>
      <div class="catalog-local-actions">
        <select id="catalogMoveGroup" aria-label="模型所属分组"></select>
        <button type="button" id="moveModelUpBtn" class="icon-command" title="模型上移" aria-label="模型上移">${icon('arrow-up')}</button>
        <button type="button" id="moveModelDownBtn" class="icon-command" title="模型下移" aria-label="模型下移">${icon('arrow-up', 'icon-down')}</button>
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

const dragType = 'application/x-flow-catalog-model';
const groupDragType = 'application/x-flow-catalog-group';
function clearDropTargets(document) {
    document.querySelectorAll('.is-drop-target').forEach(element => {
        element.classList.remove('is-drop-target');
        delete element.dataset.dropPosition;
    });
}
function draggableCard(element, type, id) {
    element.draggable = true;
    element.addEventListener('dragstart', event => {
        event.dataTransfer.setData(type, id);
        event.dataTransfer.effectAllowed = 'move';
        element.classList.add('is-dragging');
    });
    element.addEventListener('dragend', () => {
        element.classList.remove('is-dragging');
        clearDropTargets(element.ownerDocument);
    });
}
function dropTarget(element, { groupKey, onMove, targetId = '', onGroupMove }) {
    element.dataset.dropGroup = groupKey;
    const isGroupDrag = event => event.dataTransfer?.types.includes(groupDragType);
    const position = event => event.clientY < element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2 ? 'before' : 'after';
    element.ondragover = event => {
        if (isGroupDrag(event) ? !onGroupMove : !event.dataTransfer?.types.includes(dragType)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        clearDropTargets(element.ownerDocument);
        element.classList.add('is-drop-target');
        if (targetId || isGroupDrag(event)) element.dataset.dropPosition = position(event);
        const scroller = element.closest('.catalog-models,.catalog-groups');
        if (scroller) {
            const bounds = scroller.getBoundingClientRect();
            if (event.clientY < bounds.top + 30) scroller.scrollTop -= 14;
            else if (event.clientY > bounds.bottom - 30) scroller.scrollTop += 14;
        }
    };
    element.ondragleave = event => {
        if (!element.contains(event.relatedTarget)) {
            element.classList.remove('is-drop-target');
            delete element.dataset.dropPosition;
        }
    };
    element.ondrop = event => {
        clearDropTargets(element.ownerDocument);
        const group = event.dataTransfer?.getData(groupDragType);
        if (group && onGroupMove) {
            event.preventDefault();
            event.stopPropagation();
            onGroupMove(group, groupKey, position(event));
            return;
        }
        const id = event.dataTransfer?.getData(dragType);
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        onMove?.(id, groupKey, targetId, position(event));
    };
}

export function renderCatalog(document, config, selectedId, onSelect, sources, prices, costs, onToggle, workspace = {}) {
    document.getElementById('catalogMode').value = config.catalogMode === 'remote' ? 'remote' : 'fallback';
    let defaultModel = document.getElementById('catalogDefaultVideoModel');
    if (!defaultModel) {
        const label = document.createElement('label');
        label.className = 'catalog-mode';
        label.style.flexWrap = 'wrap';
        const title = document.createElement('span');
        title.textContent = '默认视频模型';
        defaultModel = document.createElement('select');
        defaultModel.id = 'catalogDefaultVideoModel';
        defaultModel.setAttribute('aria-label', '默认视频模型');
        defaultModel.style.width = '240px';
        defaultModel.style.maxWidth = '100%';
        label.append(title, defaultModel);
        document.getElementById('catalogActions').insertBefore(label, document.getElementById('addModelBtn'));
    }
    defaultModel.replaceChildren();
    const addDefault = (value, label) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        defaultModel.append(option);
    };
    addDefault('', '未指定');
    for (const entry of config.models.filter(entry => entry.kind === 'video' && entry.catalog && modelVisible(entry)
        && (!Array.isArray(config.catalogGroups) || entry.presentation?.routeGroup))) {
        addDefault(entry.id, `${entry.presentation?.routeGroupLabel ? `${entry.presentation.routeGroupLabel} / ` : ''}${modelName(entry)}`);
    }
    defaultModel.value = config.defaultModels?.video || '';
    defaultModel.onchange = event => workspace.onDefaultChange?.(event.target.value);
    const selected = config.models.find(entry => entry.id === selectedId);
    document.getElementById('catalogShowLegacyLabel').hidden = config.catalogMode !== 'remote';
    const groups = catalogGroups(config, { kind: document.getElementById('catalogKind').value,
        query: document.getElementById('catalogSearch').value, includeHidden: document.getElementById('catalogShowHidden').checked,
        includeDisabled: true, includeEmpty: true, includeUnassigned: true,
        includeLegacy: config.catalogMode !== 'remote' || document.getElementById('catalogShowLegacy').checked });
    const groupList = document.getElementById('catalogGroups');
    const groupColumn = groupList.closest('.catalog-column');
    groupColumn.style.alignSelf = 'stretch';
    dropTarget(groupColumn, { groupKey: 'new', onMove: id => workspace.onCreateGroup?.(id) });
    const modelList = document.getElementById('catalogModels');
    const ungroupedList = document.getElementById('catalogUngrouped');
    const scroll = [groupList.scrollTop, modelList.scrollTop, ungroupedList.scrollTop];
    groupList.replaceChildren();
    modelList.replaceChildren();
    ungroupedList.replaceChildren();
    const namedGroups = groups.filter(group => group.id);
    const selectedGroup = namedGroups.find(group => group.key === workspace.groupKey)
        || namedGroups.find(group => group.entries.some(entry => entry.id === selectedId)) || namedGroups[0];
    const renderEntry = entry => {
        const card = tile(document, entry, { label: modelName(entry),
        detail: [entry.catalog?.model, catalogModelSummary(entry)].filter(Boolean).join(' · ')
            || entry.presentation?.description || entry.catalog?.model || entry.id,
        hidden: !!entry.presentation?.routeGroup && entry.presentation?.visible === false, disabled: entry.catalog?.enabled === false, selected: selectedId === entry.id,
        status: entry.catalog?.enabled === false ? '已停用' : !entry.presentation?.routeGroup ? '未加入画布' : entry.presentation?.visible === false ? '已隐藏'
            : !entry.catalog ? '待补全模型 ID 与 API 主机' : selectedId === entry.id ? '当前' : '',
        warning: !entry.catalog, onClick: () => onSelect(entry.id), onToggle, sources, prices, costs });
        const wrapper = card.classList.contains('catalog-item') ? card : document.createElement('div');
        if (wrapper !== card) { wrapper.className = 'catalog-item'; wrapper.append(card); }
        const button = wrapper.querySelector('.catalog-tile');
        draggableCard(button, dragType, entry.id);
        if (entry.presentation?.routeGroup) dropTarget(wrapper, { groupKey: catalogGroupKey(entry), onMove: workspace.onMove, targetId: entry.id });
        const actions = document.createElement('div');
        actions.className = 'catalog-model-actions';
        for (const [action, title, symbol, callback, disabled] of [
            ['edit', '编辑模型参数', 'tag', () => workspace.onEdit?.(entry.id), false],
            ['group', '独立成组', 'folder-add', () => workspace.onCreateGroup?.(entry.id), false],
            ['move', entry.presentation?.routeGroup ? '移出分组' : '加入选中分组', 'arrow-up',
                () => workspace.onMove?.(entry.id, entry.presentation?.routeGroup ? '' : selectedGroup?.key),
                !entry.presentation?.routeGroup && (!selectedGroup || selectedGroup.kind !== entry.kind)]
        ]) {
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.title = title;
            actionButton.setAttribute('aria-label', `${modelName(entry)}${title}`);
            actionButton.dataset.modelAction = action;
            actionButton.dataset.actionModelId = entry.id;
            actionButton.innerHTML = icon(symbol, action === 'move' ? (entry.presentation?.routeGroup ? 'icon-right' : 'icon-left') : '');
            actionButton.disabled = disabled;
            actionButton.addEventListener('click', callback);
            actions.append(actionButton);
        }
        wrapper.append(actions);
        return wrapper;
    };
    for (const group of namedGroups) {
            const current = group.entries.find(entry => entry.id === selectedId && modelVisible(entry))
                || group.entries.find(modelVisible) || group.entries[0];
            const button = tile(document, null, { label: group.label,
                detail: group.disabled ? '分组停用' : current ? `当前使用：${modelName(current)}` : '空分组',
                status: !group.disabled && group.disabledCount ? `部分停用（${group.disabledCount}/${group.totalCount}）` : '',
                warning: !group.disabled && group.disabledCount > 0, disabled: group.disabled,
                selected: selectedGroup?.key === group.key, arrow: true,
                hidden: group.entries.length > 0 && group.entries.every(entry => entry.presentation?.visible === false),
                onClick: () => workspace.onSelectGroup?.(group.key) });
            button.dataset.catalogGroup = group.key;
            draggableCard(button, groupDragType, group.key);
            dropTarget(button, { groupKey: group.key, onMove: workspace.onMove, onGroupMove: workspace.onGroupMove });
            groupList.append(button);
    }
    if (selectedGroup) selectedGroup.entries.forEach(entry => modelList.append(renderEntry(entry)));
    const ungrouped = groups.filter(group => !group.id).flatMap(group => group.entries);
    ungrouped.forEach(entry => ungroupedList.append(renderEntry(entry)));
    modelList.ondragover = modelList.ondrop = modelList.ondragleave = null;
    delete modelList.dataset.dropGroup;
    if (selectedGroup) dropTarget(modelList, { groupKey: selectedGroup.key, onMove: workspace.onMove });
    dropTarget(ungroupedList, { groupKey: '', onMove: workspace.onMove });
    for (const [list, message] of [[groupList, '暂无分组'], [modelList, selectedGroup ? '暂无模型' : '未选择分组'], [ungroupedList, '暂无未分组模型']]) {
        if (list.children.length) continue;
        const empty = document.createElement('p');
        empty.className = 'catalog-empty';
        empty.textContent = message;
        list.append(empty);
    }
    document.getElementById('catalogModelsTitle').textContent = selectedGroup?.label || '组内模型';
    document.getElementById('catalogGroupCount').textContent = namedGroups.length;
    document.getElementById('catalogMemberCount').textContent = selectedGroup?.entries.length || 0;
    document.getElementById('catalogUngroupedCount').textContent = ungrouped.length;
    groupList.scrollTop = scroll[0];
    modelList.scrollTop = scroll[1];
    ungroupedList.scrollTop = scroll[2];
    const move = document.getElementById('catalogMoveGroup');
    move.replaceChildren();
    const addOption = (value, label) => { const option = document.createElement('option'); option.value = value; option.textContent = label; move.append(option); };
    addOption('', '未分组');
    catalogGroups(config, { kind: selected?.kind || '', includeEmpty: true }).filter(group => group.id).forEach(group => addOption(group.key, group.label));
    move.value = selected?.presentation?.routeGroup ? catalogGroupKey(selected) : '';
    move.disabled = !selected;
    const controls = ['copyModelBtn', 'deleteModelBtn', 'catalogVisible'];
    controls.forEach(id => { document.getElementById(id).disabled = !selected; });
    document.getElementById('catalogVisible').disabled = !selected || (selected.kind === 'video' && !selected.presentation?.routeGroup);
    ['renameGroupBtn', 'deleteGroupBtn', 'moveGroupUpBtn', 'moveGroupDownBtn'].forEach(id => {
        document.getElementById(id).disabled = !selectedGroup;
    });
    ['moveModelUpBtn', 'moveModelDownBtn'].forEach(id => { document.getElementById(id).disabled = !selected?.presentation?.routeGroup; });
    document.getElementById('catalogVisible').checked = !!selected && selected.presentation?.visible !== false;
    document.getElementById('clearCatalogBtn').disabled = !config.models.length && !config.catalogGroups?.length;
    document.getElementById('catalogSelection').textContent = selected
        ? `${modelName(selected)} · ${selected.catalog?.hosts?.join(' / ') || '未纳入托管目录'}` : '';
}
