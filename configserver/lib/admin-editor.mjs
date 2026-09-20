import { parseEditorConfig, readEditorValues, applyEditorValues, REFERENCE_KINDS } from './admin-editor-model.mjs';

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
    let mode = 'form';
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
    const writeConfig = () => {
        text.value = JSON.stringify(config) === JSON.stringify(original) ? originalText : JSON.stringify(config, null, 2);
    };
    const values = () => Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.value]));
    const updatePriceFields = () => {
        const status = controls.priceMode.value;
        document.getElementById('priceScope').hidden = status === 'inherit';
        document.getElementById('knownPriceFields').hidden = status !== 'known';
        for (const key of ['hosts', 'amount', 'currency', 'unit', 'source']) {
            controls[key].disabled = key === 'hosts' ? status === 'inherit' : status !== 'known';
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
            button.addEventListener('click', () => {
                if (!flushSelected()) return;
                selectedId = entry.id;
                renderEditor();
                renderList();
                [...list.children].find(button => button.dataset.modelId === selectedId)?.focus();
            });
            list.appendChild(button);
        }
        if (!entries.length) {
            const empty = document.createElement('p');
            empty.className = 'muted';
            empty.textContent = '没有匹配的模型';
            list.appendChild(empty);
        }
        list.scrollTop = scroll;
    };
    const renderEditor = () => {
        const entry = selected();
        fieldset.disabled = !entry || mode !== 'form';
        if (!entry) return;
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
        if (mode !== 'form' || !selected() || !touched.size) return true;
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
        if (nextMode === 'json' && !flushSelected()) return;
        if (nextMode === 'form') {
            try {
                config = parseEditorConfig(text.value);
                original ||= structuredClone(config);
                if (!selected()) selectedId = config.models[0].id;
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
        document.getElementById('formPane').hidden = mode !== 'form';
        document.getElementById('jsonPane').hidden = mode !== 'json';
        fieldset.disabled = mode !== 'form';
        if (mode === 'form') {
            renderList();
            renderEditor();
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
    document.querySelectorAll('[data-editor-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.editorMode)));
    document.getElementById('editorTabs').addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        setMode(event.key === 'Home' ? 'form' : event.key === 'End' ? 'json' : mode === 'form' ? 'json' : 'form');
        document.querySelector(`[data-editor-mode="${mode}"]`).focus();
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
    document.getElementById('resetBtn').addEventListener('click', () => { window.location.href = '/admin'; });
    window.addEventListener('beforeunload', event => {
        if (dirty() && !submitting) { event.preventDefault(); event.returnValue = ''; }
    });
    window.addEventListener('pageshow', () => { submitting = false; document.getElementById('saveBtn').disabled = false; });
    document.getElementById('editorTabs').hidden = false;
    updateSaveLabel();
    setMode('form');
}

if (globalThis.document) initAdminEditor(globalThis.document);
