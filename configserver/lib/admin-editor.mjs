import { parseEditorConfig, readEditorValues, applyEditorValues, REFERENCE_KINDS } from './admin-editor-model.mjs';
import { addCatalogModel, catalogGroupKey, catalogGroups, createCatalogGroup, createCatalogHistory,
    deleteCatalogModel, modelName, moveCatalogModel, renameCatalogGroup, reorderCatalog, setCatalogEnabled, toggleCatalogVisibility } from './admin-catalog-model.mjs';
import { appendCatalogPrices, appendCatalogSource, renderCatalog } from './admin-catalog-view.mjs';

export function initAdminEditor(document) {
    const window = document.defaultView;
    const form = document.getElementById('configForm');
    const text = document.getElementById('configText');
    const state = document.getElementById('editorState');
    const errors = document.getElementById('editorErrors');
    const fieldset = document.getElementById('modelFields');
    const list = document.getElementById('modelList');
    const search = document.getElementById('modelSearch');
    const kind = document.getElementById('modelKind');
    const originalText = text.value;
    const controls = Object.fromEntries([...fieldset.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input]));
    let config = null;
    let original = null;
    let selectedId = '';
    let mode = 'json';
    let history = null;
    let catalogSources = null;
    let catalogCosts = null;
    let catalogPrices = null;
    const touched = new Set();
    let submitting = false;
    const selected = () => config?.models.find(entry => entry.id === selectedId);
    const setState = (message, bad = false) => {
        state.textContent = message;
        state.dataset.error = String(bad);
    };
    const showErrors = messages => {
        errors.hidden = !messages?.length;
        errors.textContent = (messages || []).join('\n');
    };
    const dirty = () => text.value !== originalText || touched.size > 0;
    const writeConfig = (record = true) => {
        text.value = JSON.stringify(config) === JSON.stringify(original) ? originalText : JSON.stringify(config, null, 2);
        if (record) history?.push(config);
        document.getElementById('undoCatalogBtn').disabled = !history?.canUndo;
        document.getElementById('redoCatalogBtn').disabled = !history?.canRedo;
    };
    const values = () => Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.value]));
    const updatePriceFields = () => {
        const status = controls.priceMode.value;
        document.getElementById('priceScope').hidden = status === 'inherit';
        document.getElementById('knownPriceFields').hidden = status !== 'known';
        for (const key of ['hosts', 'amount', 'currency', 'unit', 'source']) {
            controls[key].disabled = mode === 'operation' || (key === 'hosts' ? status === 'inherit' : status !== 'known');
            controls[key].required = !controls[key].disabled;
        }
    };
    // Hidden inputs stay disabled so the browser never blocks submit on a control nobody can see.
    // `required` is listed explicitly: an optional field may still carry an example placeholder.
    const toggleGroup = (element, shown, keys, required = []) => {
        element.hidden = !shown;
        for (const key of keys) {
            controls[key].disabled = !shown;
            controls[key].required = shown && required.includes(key);
        }
    };
    const updateDurationFields = () => {
        // Named distinctly from the editor's own `mode` to keep the two from being confused.
        const constraint = controls.durationMode.value;
        // 'other' = 现有约束不在表单编辑范围：不展开任何明细，交给 JSON 视图处理。
        const editable = !['none', 'other'].includes(constraint);
        toggleGroup(document.getElementById('durationFixed'), constraint === 'fixed', ['durationValue'], ['durationValue']);
        toggleGroup(document.getElementById('durationRange'), constraint === 'range',
            ['durationMin', 'durationMax', 'durationInteger'], ['durationMin', 'durationMax']);
        toggleGroup(document.getElementById('durationEnum'), constraint === 'enum',
            ['durationValues', 'durationAllowAuto'], ['durationValues']);
        toggleGroup(document.getElementById('durationDefaultField'), ['range', 'enum'].includes(constraint), ['durationDefault']);
        toggleGroup(document.getElementById('durationNoteField'), editable, ['durationNote']);
        document.getElementById('durationNoteLabel').textContent = ['unsupported', 'unknown'].includes(constraint)
            ? '原因说明' : '补充说明';
    };
    const updateReferenceFields = entryKind => {
        for (const reference of REFERENCE_KINDS) {
            const block = document.querySelector(`[data-reference="${reference.key}"]`);
            const applies = !entryKind || reference.kinds.includes(entryKind);
            const support = controls[`${reference.key}Mode`].value;
            block.hidden = !applies;
            controls[`${reference.key}Mode`].disabled = !applies;
            for (const [selector, key] of [['[data-reference-max]', 'Max'], ['[data-reference-bytes]', 'Bytes'],
                ['[data-reference-note]', 'Note']]) {
                const field = block.querySelector(selector);
                if (!field) continue;
                const shown = applies && (key === 'Note' ? support !== 'none' : support === 'supported');
                toggleGroup(field, shown, [`${reference.key}${key}`]);
            }
            const label = block.querySelector('[data-reference-note-label]');
            if (label) label.textContent = support === 'unsupported' ? '原因说明' : '补充说明';
        }
    };
    const updateConstraintFields = () => {
        updateDurationFields();
        updateReferenceFields(selected()?.kind || '');
    };
    const renderList = () => {
        const scroll = list.scrollTop;
        const query = search.value.trim().toLowerCase();
        const entries = (config?.models || []).filter(entry => (!kind.value || entry.kind === kind.value)
            && [entry.id, entry.label, entry.presentation?.label, entry.presentation?.routeLabel].join(' ').toLowerCase().includes(query));
        list.replaceChildren();
        document.getElementById('modelCount').textContent = `${entries.length} / ${config?.models.length || 0}`;
        for (const entry of entries) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'model-entry';
            button.dataset.modelId = entry.id;
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(entry.id === selectedId));
            const label = document.createElement('strong');
            label.textContent = entry.presentation?.label || entry.label || entry.id;
            const detail = document.createElement('small');
            detail.textContent = [({ image: '图片', video: '视频', text: '文字' })[entry.kind] || entry.kind,
                entry.presentation?.routeLabel, entry.id].filter(Boolean).join(' · ');
            button.append(label, detail);
            appendCatalogPrices(document, button, entry, catalogPrices, catalogCosts);
            appendCatalogSource(document, button, entry, catalogSources);
            button.addEventListener('click', () => selectModel(entry.id));
            list.appendChild(button);
        }
        if (!entries.length) {
            const empty = document.createElement('p');
            empty.className = 'muted';
            empty.textContent = '没有匹配的模型';
            list.appendChild(empty);
        }
        list.scrollTop = scroll;
        if (config) renderCatalog(document, config, selectedId, selectModel, catalogSources, catalogPrices, catalogCosts, toggleModelCall);
    };
    function selectModel(id) {
        if (!flushSelected()) return;
        const focused = document.activeElement;
        const parentId = focused?.closest('#modelList,#catalogGroups,#catalogModels')?.id;
        const groupKey = focused?.dataset.catalogGroup;
        selectedId = id;
        renderEditor();
        renderList();
        if (parentId === 'modelList') [...list.children].find(button => button.dataset.modelId === id)?.focus({ preventScroll: true });
        else if (['catalogGroups', 'catalogModels'].includes(parentId)) {
            [...document.getElementById(parentId).querySelectorAll('.catalog-tile')].find(button => groupKey
                ? button.dataset.catalogGroup === groupKey : button.dataset.catalogModelId === id)?.focus({ preventScroll: true });
        }
    }
    const renderEditor = () => {
        const entry = selected();
        fieldset.disabled = !entry || mode === 'json';
        document.getElementById('selectedModelId').textContent = entry?.id || '未选择模型';
        document.getElementById('restoreModelBtn').disabled = !original?.models.some(model => model.id === entry?.id);
        if (!entry) {
            touched.clear();
            for (const input of Object.values(controls)) input.value = '';
            return;
        }
        touched.clear();
        const current = readEditorValues(entry);
        for (const [key, input] of Object.entries(controls)) input.value = current[key] ?? '';
        document.getElementById('selectedModelId').textContent = entry.id;
        document.getElementById('restoreModelBtn').disabled = !original?.models.some(model => model.id === entry.id);
        document.getElementById('priceUpdatedAt').textContent = current.updatedAt || '未设置';
        updatePriceFields();
        updateConstraintFields();
    };
    function flushSelected(report = true) {
        if (mode === 'json' || !selected() || !touched.size) return true;
        try {
            const next = applyEditorValues(selected(), values(), touched);
            config.models[config.models.findIndex(entry => entry.id === selectedId)] = next;
            writeConfig();
            touched.clear();
            document.getElementById('priceUpdatedAt').textContent = next.pricing?.updatedAt || '未设置';
            setState(dirty() ? '有未保存修改' : '无修改');
            showErrors([]);
            return true;
        } catch (error) {
            setState('当前模型有待修正的字段', true);
            showErrors([error.message]);
            if (report) form.reportValidity();
            return false;
        }
    }
    function setMode(nextMode) {
        if (!flushSelected()) return;
        if (nextMode !== 'json') {
            try {
                config = parseEditorConfig(text.value);
                original ||= structuredClone(config);
                history ||= createCatalogHistory(config);
                history.push(config);
                if (!selected()) selectedId = config.models[0]?.id || '';
                if (nextMode === 'operation' && document.getElementById('catalogKind').value
                    && selected()?.kind !== document.getElementById('catalogKind').value) {
                    selectedId = config.models.find(entry => entry.kind === document.getElementById('catalogKind').value)?.id || '';
                }
                showErrors([]);
            } catch (error) {
                showErrors([error.message]);
                setState('JSON 无法转为表单', true);
                nextMode = 'json';
            }
        }
        mode = nextMode;
        for (const button of document.querySelectorAll('[data-editor-mode]')) {
            button.setAttribute('aria-selected', String(button.dataset.editorMode === mode));
            button.tabIndex = button.dataset.editorMode === mode ? 0 : -1;
        }
        document.getElementById('formPane').hidden = mode === 'json';
        document.getElementById('formPane').classList.toggle('is-operation', mode === 'operation');
        document.getElementById('formPane').setAttribute('aria-labelledby', mode === 'operation' ? 'operationTab' : 'formTab');
        document.getElementById('catalogPane').hidden = mode !== 'operation';
        document.getElementById('catalogActions').hidden = mode === 'json';
        document.getElementById('jsonPane').hidden = mode !== 'json';
        fieldset.disabled = mode === 'json';
        if (mode !== 'json') {
            renderList();
            renderEditor();
            document.getElementById('undoCatalogBtn').disabled = !history?.canUndo;
            document.getElementById('redoCatalogBtn').disabled = !history?.canRedo;
            setState(dirty() ? '有未保存修改' : '无修改');
        }
    }
    fieldset.addEventListener('input', event => {
        if (!event.target.dataset.field) return;
        touched.add(event.target.dataset.field);
        updatePriceFields();
        updateConstraintFields();
        if (flushSelected(false)) renderList();
    });
    // Selects also emit input in current desktop browsers.
    search.addEventListener('input', renderList);
    kind.addEventListener('change', renderList);
    list.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...list.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
        event.preventDefault();
        buttons[next]?.click();
    });
    for (const id of ['catalogGroups', 'catalogModels']) {
        document.getElementById(id).addEventListener('keydown', event => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            if (document.activeElement?.classList.contains('catalog-call-switch')) return;
            const buttons = [...event.currentTarget.querySelectorAll('.catalog-tile')];
            const index = buttons.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
            event.preventDefault();
            buttons[next]?.click();
            [...document.getElementById(id).querySelectorAll('.catalog-tile')][next]?.focus();
        });
    }
    document.querySelectorAll('[data-editor-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.editorMode)));
    document.getElementById('editorTabs').addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const modes = ['operation', 'form', 'json'];
        const index = modes.indexOf(mode);
        setMode(event.key === 'Home' ? 'operation' : event.key === 'End' ? 'json'
            : modes[(index + (event.key === 'ArrowLeft' ? -1 : 1) + modes.length) % modes.length]);
        document.querySelector(`[data-editor-mode="${mode}"]`).focus();
    });
    function replaceConfig(next, id = selectedId, record = true) {
        config = next;
        selectedId = config.models.some(entry => entry.id === id) ? id : config.models[0]?.id || '';
        touched.clear();
        writeConfig(record);
        renderEditor();
        renderList();
        showErrors([]);
        setState(dirty() ? '有未保存修改' : '无修改');
    }
    const operate = action => {
        if (!flushSelected()) return;
        try { replaceConfig(action()); }
        catch (error) { showErrors([error.message]); setState('操作未完成', true); }
    };
    function toggleModelCall(id, enabled) {
        if (!flushSelected()) return;
        const parentId = document.activeElement?.closest('#catalogGroups,#catalogModels')?.id;
        try {
            replaceConfig(setCatalogEnabled(config, id, enabled));
            if (parentId) [...document.getElementById(parentId).querySelectorAll('.catalog-call-switch')]
                .find(toggle => toggle.dataset.callModelId === id)?.focus({ preventScroll: true });
        } catch (error) { showErrors([error.message]); setState('调用状态未修改', true); }
    }
    document.getElementById('catalogMode').addEventListener('change', event => {
        const catalogMode = event.target.value;
        operate(() => ({ ...config, catalogMode }));
    });
    for (const [id, direction, scope] of [['moveModelUpBtn', -1, 'model'], ['moveModelDownBtn', 1, 'model'],
        ['moveGroupUpBtn', -1, 'group'], ['moveGroupDownBtn', 1, 'group']]) {
        document.getElementById(id).addEventListener('click', () => operate(() => reorderCatalog(config, selectedId, direction, scope)));
    }
    document.getElementById('catalogMoveGroup').addEventListener('change', event => {
        const destination = event.target.value;
        operate(() => moveCatalogModel(config, selectedId, destination));
    });
    document.getElementById('catalogVisible').addEventListener('change', () => operate(() => toggleCatalogVisibility(config, selectedId)));
    document.getElementById('deleteModelBtn').addEventListener('click', () => operate(() => deleteCatalogModel(config, selectedId)));
    for (const [id, method] of [['undoCatalogBtn', 'undo'], ['redoCatalogBtn', 'redo']]) {
        document.getElementById(id).addEventListener('click', () => {
            if (history && flushSelected()) replaceConfig(history[method](), selectedId, false);
        });
    }
    const filterCatalog = () => {
        if (!flushSelected()) return;
        const groups = catalogGroups(config, { kind: document.getElementById('catalogKind').value,
            query: document.getElementById('catalogSearch').value, includeHidden: document.getElementById('catalogShowHidden').checked,
            includeDisabled: true,
            includeLegacy: config.catalogMode !== 'remote' || document.getElementById('catalogShowLegacy').checked });
        if (!groups.some(group => group.entries.some(entry => entry.id === selectedId))) {
            selectedId = groups[0]?.entries[0]?.id || '';
            renderEditor();
        }
        renderList();
    };
    document.getElementById('catalogSearch').addEventListener('input', filterCatalog);
    document.getElementById('catalogKind').addEventListener('change', filterCatalog);
    document.getElementById('catalogShowHidden').addEventListener('change', filterCatalog);
    document.getElementById('catalogShowLegacy').addEventListener('change', filterCatalog);
    const dialog = document.getElementById('catalogDialog');
    const dialogFields = document.getElementById('catalogDialogFields');
    const dialogError = document.getElementById('catalogDialogError');
    let dialogAction = '';
    function openDialog(action) {
        if (!flushSelected()) return;
        dialogAction = action;
        const creating = action === 'add' || action === 'copy';
        const grouping = action === 'createGroup' || action === 'renameGroup';
        document.getElementById('catalogDialogTitle').textContent = ({ add: '新增模型', copy: '复制模型',
            createGroup: '新建分组', renameGroup: '修改分组名', clear: '清空模型目录' })[action];
        dialogFields.disabled = false;
        for (const row of dialogFields.querySelectorAll('[data-dialog-row]')) {
            row.hidden = !creating && !(grouping && row.dataset.dialogRow === 'label');
            for (const input of row.querySelectorAll('input,select,textarea')) {
                input.disabled = row.hidden;
                input.required = !row.hidden;
            }
        }
        document.getElementById('catalogDialogLabelTitle').textContent = grouping ? '分组名' : '显示名称';
        document.getElementById('catalogDialogLabel').value = action === 'renameGroup'
            ? selected()?.presentation?.routeGroupLabel || selected()?.presentation?.routeGroup || ''
            : action === 'copy' ? `${modelName(selected())} 副本`.slice(0, 100) : '';
        document.getElementById('catalogDialogKind').value = selected()?.kind || document.getElementById('catalogKind').value || 'video';
        document.getElementById('catalogDialogModel').value = '';
        document.getElementById('catalogDialogHosts').value = selected()?.catalog?.hosts?.join('\n') || '';
        const message = document.getElementById('catalogDialogMessage');
        message.hidden = action !== 'clear';
        message.textContent = `移除目录中的 ${config.models.length} 个模型？`;
        document.getElementById('catalogDialogConfirm').textContent = action === 'clear' ? '清空目录' : '确定';
        dialogError.hidden = true;
        dialog.showModal();
        (creating || grouping ? document.getElementById('catalogDialogLabel') : document.getElementById('catalogDialogCancel')).focus();
    }
    for (const [id, action] of [['addModelBtn', 'add'], ['copyModelBtn', 'copy'], ['createGroupBtn', 'createGroup'],
        ['renameGroupBtn', 'renameGroup'], ['clearCatalogBtn', 'clear']]) {
        document.getElementById(id).addEventListener('click', () => openDialog(action));
    }
    dialog.addEventListener('close', () => { dialogFields.disabled = true; });
    document.getElementById('catalogDialogCancel').addEventListener('click', () => dialog.close());
    function confirmDialog() {
        for (const input of dialogFields.querySelectorAll('input,select,textarea')) {
            if (!input.disabled && !input.reportValidity()) return;
        }
        try {
            const label = document.getElementById('catalogDialogLabel').value;
            if (dialogAction === 'add' || dialogAction === 'copy') {
                const kind = document.getElementById('catalogDialogKind').value;
                const result = addCatalogModel(config, { label, kind,
                    model: document.getElementById('catalogDialogModel').value,
                    hosts: document.getElementById('catalogDialogHosts').value,
                    sourceId: dialogAction === 'copy' ? selectedId : undefined,
                    groupKey: selected()?.kind === kind && selected()?.presentation?.routeGroup ? catalogGroupKey(selected()) : '' });
                document.getElementById('catalogKind').value = kind;
                document.getElementById('catalogSearch').value = '';
                replaceConfig(result.config, result.id);
            } else if (dialogAction === 'createGroup') replaceConfig(createCatalogGroup(config, selectedId, label));
            else if (dialogAction === 'renameGroup') replaceConfig(renameCatalogGroup(config, catalogGroupKey(selected()), label));
            else if (dialogAction === 'clear') replaceConfig({ ...config, models: [] });
            dialog.close();
        } catch (error) {
            dialogError.textContent = error.message;
            dialogError.hidden = false;
        }
    }
    document.getElementById('catalogDialogConfirm').addEventListener('click', confirmDialog);
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
            event.preventDefault();
            event.stopPropagation();
            confirmDialog();
        }
    });
    const updateSaveLabel = () => { document.getElementById('saveBtn').textContent = form.elements.draft.checked ? '保存草稿' : '发布配置'; };
    form.elements.draft.addEventListener('change', updateSaveLabel);
    document.getElementById('restoreModelBtn').addEventListener('click', () => {
        const prior = original?.models.find(entry => entry.id === selectedId);
        if (!prior) return;
        config.models[config.models.findIndex(entry => entry.id === selectedId)] = structuredClone(prior);
        writeConfig();
        renderEditor();
        renderList();
        showErrors([]);
        setState('已还原所选模型');
    });
    text.addEventListener('input', () => { setState('有未保存修改'); showErrors([]); });
    document.getElementById('formatBtn').addEventListener('click', () => {
        try { text.value = JSON.stringify(JSON.parse(text.value), null, 2); setState('已格式化'); showErrors([]); }
        catch (error) { setState('JSON 解析失败', true); showErrors([error.message]); }
    });
    document.getElementById('validateBtn').addEventListener('click', async () => {
        if (!flushSelected()) return;
        const snapshot = text.value;
        setState('校验中…');
        try {
            const response = await window.fetch('/admin/validate', { method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': form.elements.csrf.value }, body: snapshot });
            const result = await response.json();
            if (snapshot !== text.value || touched.size) return;
            if (result.ok) { setState(`校验通过 · ${result.modelCount} 个模型`); showErrors([]); }
            else { setState('校验未通过', true); showErrors(result.errors || [result.error || '请重新登录后重试']); }
        } catch (error) { setState('校验请求失败', true); showErrors([error.message]); }
    });
    form.addEventListener('submit', event => {
        if (submitting || !flushSelected()) { event.preventDefault(); return; }
        submitting = true;
        document.getElementById('saveBtn').disabled = true;
        setState('正在保存…');
    });
    form.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            form.requestSubmit(document.getElementById('saveBtn'));
        } else if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
            event.preventDefault();
        }
    });
    document.getElementById('resetBtn').addEventListener('click', () => {
        window.location.href = form.elements.channel?.value === 'preview' ? '/admin?channel=preview' : '/admin';
    });
    window.addEventListener('beforeunload', event => {
        if (dirty() && !submitting) { event.preventDefault(); event.returnValue = ''; }
    });
    window.addEventListener('pageshow', () => { submitting = false; document.getElementById('saveBtn').disabled = false; });
    document.getElementById('editorTabs').hidden = false;
    updateSaveLabel();
    setMode('operation');
    window.fetch('/admin/model-costs', { credentials: 'same-origin', cache: 'no-store' })
        .then(response => {
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Cost lookup failed');
            return response.json();
        })
        .then(costs => {
            if (!Array.isArray(costs.entries)) throw new Error('Invalid cost snapshot');
            catalogCosts = costs;
        })
        .catch(() => { catalogCosts = { error: true }; })
        .finally(() => { if (config) renderList(); });
    window.fetch('/admin/model-prices', { credentials: 'same-origin', cache: 'no-store' })
        .then(response => {
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Price lookup failed');
            return response.json();
        })
        .then(prices => {
            if (!Array.isArray(prices.sites)) throw new Error('Invalid price snapshot');
            catalogPrices = prices;
        })
        .catch(() => { catalogPrices = { error: true }; })
        .finally(() => { if (config) renderList(); });
    window.fetch('/admin/model-sources', { credentials: 'same-origin', cache: 'no-store' })
        .then(response => {
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Source lookup failed');
            return response.json();
        })
        .then(sources => {
            if (!Array.isArray(sources.entries)) throw new Error('Invalid source catalog');
            catalogSources = sources;
        })
        .catch(() => { catalogSources = { error: true }; })
        .finally(() => { if (config) renderList(); });
}

if (globalThis.document) initAdminEditor(globalThis.document);
