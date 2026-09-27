const copy = value => structuredClone(value);
const name = entry => (entry.presentation?.routeGroup && entry.presentation?.routeLabel)
    || entry.presentation?.label || entry.label || entry.catalog?.model || entry.id;
const order = (value, fallback) => Number.isInteger(value) ? value : fallback;
export const modelName = name;
export const modelVisible = entry => entry.presentation?.visible !== false && entry.catalog?.enabled !== false;
export const catalogGroupKey = entry => entry.presentation?.routeGroup
    ? `${entry.kind}:${entry.presentation.routeGroup}` : `model:${entry.id}`;

export function catalogModelPrices(entry, snapshot) {
    const units = { request: '次', second: '秒', image: '张', million_tokens: '百万 Token' };
    return [['art.ravenhash.org', '老站'], ['cart.ravenhash.org', '新站']].map(([host, label]) => {
        const site = snapshot?.sites?.find(site => site.host === host);
        const checkedAt = site?.checkedAt || snapshot?.checkedAt;
        const title = checkedAt ? `中转站计费核对：${checkedAt}` : '';
        const line = value => ({ host, text: `${label}价格：${value}`, title });
        if (snapshot === null) return line('读取中');
        if (snapshot?.error) return line('读取失败');
        if (!Array.isArray(site?.models)) return line('待核对');
        const record = entry.catalog?.model
            ? site.models.find(model => model.model === entry.catalog.model)
            : site.models.find(model => model.ids?.includes(entry.id));
        if (!record) return line(entry.kind && entry.kind !== 'video' ? '待核对'
            : entry.catalog?.model ? '未接入' : '待绑定模型');
        if (record.status === 'missing_rule') return line('未配置计费规则');
        if (record.status === 'inactive_rule') return line('计费规则已停用');
        const prices = record.prices;
        if (record.status !== 'known' || !['CNY', 'USD'].includes(record.currency)
            || !Array.isArray(prices) || !prices.length
            || prices.some(price => !Number.isFinite(price.amount) || price.amount < 0 || !Object.hasOwn(units, price.unit))) {
            return line(record.reason || '待核对');
        }
        const currency = record.currency === 'CNY' ? '¥' : 'US$';
        const formatted = prices.map(price => {
            const amount = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price.amount);
            return `${price.label ? `${price.label} ` : ''}${currency}${amount}/${units[price.unit]}`;
        }).join('；');
        return line(`${formatted}${record.reason ? `；${record.reason}` : ''}${record.active === false ? '（已下架）' : ''}`);
    });
}

export function catalogModelCost(entry, snapshot) {
    const line = (text, title = '', status = 'unknown') => ({ text: `成本价：${text}`, title, status });
    if (snapshot === null) return line('读取中');
    if (snapshot?.error) return line('读取失败');
    const record = snapshot?.entries?.find(record => record.ids?.includes(entry.id)
        && (!entry.catalog || record.models?.includes(entry.catalog.model)));
    if (!record) return line('待核对');
    if (entry.catalog) {
        let supplierHost;
        try { supplierHost = new URL(record.sourceUrl).hostname; } catch { return line('待核对'); }
        const allowed = new Set(['art.ravenhash.org', 'cart.ravenhash.org', supplierHost]);
        if (!entry.catalog.hosts?.length || entry.catalog.hosts.some(host => !allowed.has(host))) return line('待核对上游绑定');
    }
    const title = `${record.supplier}\n核对：${snapshot.checkedAt}\n${record.sourceUrl}`;
    if (record.status === 'unknown') return line(`待核对（${record.note}）`, title);
    const units = { request: '次', second: '秒', image: '张', million_tokens: '百万 Token' };
    if (!['reference', 'historical'].includes(record.status) || !['CNY', 'USD', 'CREDITS'].includes(record.currency)
        || !Array.isArray(record.prices) || !record.prices.length
        || record.prices.some(price => !Number.isFinite(price.amount) || price.amount < 0 || !Object.hasOwn(units, price.unit))) return line('待核对', title);
    const formatted = record.prices.map(price => {
        const amount = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(price.amount);
        const value = record.currency === 'CREDITS' ? `${amount} 积分` : `${record.currency === 'CNY' ? '¥' : 'US$'}${amount}`;
        return `${price.label ? `${price.label} ` : ''}${value}/${units[price.unit]}`;
    }).join('；');
    return line(`${record.status === 'historical' ? '历史报价 ' : '上游参考价 '}${formatted}（${record.note}）`, title, record.status);
}

export function catalogModelSource(entry, sources) {
    const pending = sources === null ? '读取中' : sources?.error ? '读取失败' : '待确认';
    const record = Array.isArray(sources?.entries) && sources.entries.find(source => {
        if (!Array.isArray(source.ids) || !source.ids.includes(entry.id)) return false;
        if (!entry.catalog) return true;
        return source.models?.includes(entry.catalog.model) && Array.isArray(entry.catalog.hosts)
            && entry.catalog.hosts.length > 0 && entry.catalog.hosts.every(host => source.hosts?.includes(host));
    });
    let url = '';
    try {
        const parsed = new URL(record?.url);
        if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
            && !parsed.search && !parsed.hash) url = record.url;
    } catch { /* Missing or invalid supplier addresses remain unconfirmed. */ }
    return { name: `上游：${typeof record?.name === 'string' && record.name.trim() ? record.name : pending}`,
        url: `URL：${url || pending}` };
}

export function catalogModelSummary(entry) {
    const options = entry.options || {};
    const resolution = options.resolutionTier || options.resolution;
    const scalar = value => ['string', 'number'].includes(typeof value) ? String(value) : '';
    const choices = constraint => (Array.isArray(constraint?.values) ? constraint.values : []).map(scalar).filter(Boolean).join('/');
    const parts = [];
    const quality = resolution?.type === 'fixed' ? scalar(resolution.value)
        : ['enum', 'tier'].includes(resolution?.type) ? choices(resolution) : '';
    if (quality) parts.push(quality);
    const duration = options.duration;
    if (duration?.type === 'fixed' && scalar(duration.value)) parts.push(`固定 ${scalar(duration.value)} 秒`);
    else if (duration?.type === 'range' && scalar(duration.min) && scalar(duration.max)) parts.push(`${scalar(duration.min)}-${scalar(duration.max)} 秒`);
    else if (duration?.type === 'enum' && choices(duration)) parts.push(`${choices(duration)} 秒`);
    const limited = [];
    const supported = [];
    const unsupported = [];
    for (const [key, label] of [['referenceImages', '图'], ['referenceVideos', '视频'], ['referenceAudios', '音频']]) {
        const capability = entry.capabilities?.[key];
        if (capability?.supported === false) unsupported.push(label);
        else if (capability?.supported === true) {
            if (Number.isInteger(capability.max) && capability.max >= 0) limited.push(`${capability.max} ${label}`);
            else supported.push(label);
        }
    }
    if (limited.length) parts.push(`最多 ${limited.join(' / ')}参考`);
    if (supported.length) parts.push(`支持${supported.join('/')}参考`);
    if (unsupported.length) parts.push(`不支持${unsupported.join('/')}参考`);
    return parts.join('；');
}

export function parseCatalogHosts(value) {
    const hosts = [...new Set(String(value || '').split(/[\s,;，；]+/).filter(Boolean).map(host => host.toLowerCase()))];
    if (!hosts.length || hosts.some(host => host.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host))) {
        throw new Error('API 主机名不能为空，且不能包含协议、路径、端口或通配符');
    }
    return hosts;
}

export function applyCatalogFields(entry, values) {
    const model = String(values.catalogModel || '').trim();
    const hostsText = String(values.catalogHosts || '').trim();
    const next = copy(entry);
    if (!model && !hostsText) {
        delete next.catalog;
        return next;
    }
    if (!model || model.length > 200 || /\s/.test(model)) throw new Error('模型 ID 需要 1 到 200 个非空白字符');
    const hosts = parseCatalogHosts(hostsText);
    next.catalog = { ...next.catalog, model, hosts, enabled: values.catalogEnabled !== 'false' };
    // Explicit IDs are escaped into exact matches; existing regexes are never used as an ID source.
    next.match = { ...next.match, model: [`^${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`] };
    return next;
}

export function catalogGroups(config, { kind = '', query = '', includeHidden = true, includeDisabled = false, includeLegacy = true, includeEmpty = false, includeUnassigned = false } = {}) {
    const groups = new Map();
    config.models.forEach((entry, index) => {
        if (kind && kind !== entry.kind) return;
        if (!includeLegacy && !entry.catalog) return;
        const key = catalogGroupKey(entry);
        if (!groups.has(key)) groups.set(key, { key, id: entry.presentation?.routeGroup || '', kind: entry.kind,
            label: entry.presentation?.routeGroupLabel || entry.presentation?.routeGroup || name(entry),
            order: order(entry.presentation?.routeGroupOrder, 0), index, entries: [] });
        const group = groups.get(key);
        group.entries.push({ entry, index });
    });
    // Empty groups are editor metadata; canvas clients still read each model's presentation.
    for (const group of config.catalogGroups || []) {
        if (!group.id || !['image', 'video', 'text'].includes(group.kind) || (kind && kind !== group.kind)) continue;
        const key = `${group.kind}:${group.id}`;
        if (!groups.has(key)) groups.set(key, { ...group, key, index: config.models.length + groups.size, entries: [] });
    }
    const normalized = String(query).trim().toLowerCase();
    return [...groups.values()].map(group => {
        const members = group.entries.sort((a, b) => order(a.entry.presentation?.routeOrder, 0)
            - order(b.entry.presentation?.routeOrder, 0)
            || ((a.entry.presentation?.routeLabel || '') < (b.entry.presentation?.routeLabel || '') ? -1
                : (a.entry.presentation?.routeLabel || '') > (b.entry.presentation?.routeLabel || '') ? 1 : 0)
            || a.index - b.index).map(item => item.entry);
        const entries = members.filter(entry => includeHidden || (includeUnassigned && !entry.presentation?.routeGroup) || (entry.presentation?.visible !== false
            && (includeDisabled || entry.catalog?.enabled !== false)));
        const disabledCount = members.filter(entry => entry.catalog?.enabled === false).length;
        return { ...group, entries, disabledCount, totalCount: members.length,
            disabled: members.length > 0 && disabledCount === members.length,
            order: order(entries[0]?.presentation?.routeGroupOrder, group.order) };
    }).filter(group => group.entries.length || (includeEmpty && group.totalCount === 0)).sort((a, b) => a.order - b.order || a.index - b.index)
        .filter(group => !normalized || [group.label, ...group.entries.flatMap(entry =>
        [name(entry), entry.catalog?.model, entry.id, ...(entry.catalog?.hosts || [])])].join(' ').toLowerCase().includes(normalized));
}

function requireEntry(config, id) {
    const entry = config.models.find(entry => entry.id === id);
    if (!entry) throw new Error('请选择一个模型');
    return entry;
}

export function addCatalogModel(config, { model, hosts, label, kind = 'video', sourceId, groupKey = '' }) {
    if (!['image', 'video', 'text'].includes(kind)) throw new Error('请选择模型类型');
    const next = copy(config);
    const source = sourceId ? requireEntry(next, sourceId) : { kind, presentation: {}, match: {} };
    let index = 1;
    let id = `catalog.${kind}.${model}`;
    while (next.models.some(entry => entry.id === id)) id = `catalog.${kind}.${model}.${++index}`;
    const entry = applyCatalogFields({ ...copy(source), id, kind },
        { catalogModel: model, catalogHosts: hosts, catalogEnabled: 'true' });
    if (next.models.some(existing => existing.kind === kind && existing.catalog?.model === entry.catalog.model
        && existing.catalog.hosts.some(host => entry.catalog.hosts.includes(host)))) {
        throw new Error('该模型 ID 在所选 API 主机下已存在');
    }
    entry.presentation = { ...entry.presentation, label: String(label || model).trim(), visible: true };
    if (!entry.presentation.label || entry.presentation.label.length > 100) throw new Error('显示名称需要 1 到 100 个字符');
    if (groupKey || entry.presentation.routeLabel) entry.presentation.routeLabel = entry.presentation.label;
    next.models.push(entry);
    return { config: moveCatalogModel(next, id, groupKey), id };
}

function rememberCatalogGroup(config, group) {
    if (!group?.id) return;
    const first = group.entries[0]?.presentation || {};
    const record = { id: group.id, kind: group.kind, label: group.label, order: group.order,
        scope: first.routeGroupScope || group.scope || 'catalog',
        description: first.routeGroupDescription || group.description || '' };
    config.catalogGroups = (config.catalogGroups || []).filter(item => item.id !== group.id || item.kind !== group.kind);
    config.catalogGroups.push(record);
}

export function normalizeCatalogWorkspace(config) {
    const next = copy(config);
    for (const entry of Array.isArray(next.catalogGroups) ? next.models : []) {
        if (!entry.catalog || entry.kind !== 'video') continue;
        const groupId = entry.presentation?.routeGroup;
        if (!groupId) entry.presentation = { ...entry.presentation, visible: false };
        else {
            const group = next.catalogGroups.find(group => group.id === groupId && group.kind === entry.kind);
            if (group) entry.presentation = { ...entry.presentation, routeGroupScope: group.scope || 'catalog' };
        }
    }
    for (const [kind, id] of Object.entries(next.defaultModels || {})) {
        if (!next.models.some(entry => entry.id === id && entry.kind === kind && entry.catalog
            && entry.catalog.enabled !== false && entry.presentation?.visible !== false)) delete next.defaultModels[kind];
    }
    if (next.defaultModels && !Object.keys(next.defaultModels).length) delete next.defaultModels;
    return next;
}

export function setCatalogDefaultModel(config, kind, id) {
    if (!['video', 'image', 'text'].includes(kind)) throw new Error('请选择模型类型');
    const next = normalizeCatalogWorkspace(config);
    if (!id) {
        if (next.defaultModels) delete next.defaultModels[kind];
    } else {
        const entry = requireEntry(next, id);
        if (entry.kind !== kind || !entry.catalog || entry.catalog.enabled === false || entry.presentation?.visible === false) {
            throw new Error('默认模型必须已加入画布且允许调用');
        }
        next.defaultModels = { ...next.defaultModels, [kind]: id };
    }
    return normalizeCatalogWorkspace(next);
}

export function moveCatalogModel(config, id, groupKey, targetId = '', placement = 'before') {
    const next = copy(config);
    const entry = requireEntry(next, id);
    const groups = catalogGroups(next, { includeEmpty: true });
    const group = groups.find(group => group.key === groupKey && group.id);
    if (groupKey && !group) throw new Error('目标分组已不存在');
    if (group && group.kind !== entry.kind) throw new Error('模型只能移动到相同类型的分组');
    if (targetId === id) return next;
    if (targetId && !group?.entries.some(model => model.id === targetId)) throw new Error('目标模型已不在该分组');
    rememberCatalogGroup(next, groups.find(group => group.key === catalogGroupKey(entry)));
    rememberCatalogGroup(next, group);
    const display = { ...entry.presentation };
    if (group) {
        const template = group.entries[0]?.presentation || {};
        Object.assign(display, { routeGroup: group.id, routeGroupLabel: group.label,
            routeLabel: display.routeLabel || name(entry),
            routeGroupScope: template.routeGroupScope || group.scope || 'catalog', routeGroupAlways: true,
            routeGroupDescription: template.routeGroupDescription || group.description || '',
            routeGroupOrder: group.order,
            routeOrder: Math.max(-1, ...group.entries.map(model => order(model.presentation?.routeOrder, 0))) + 1 });
        if (!entry.presentation?.routeGroup && entry.kind === 'video') display.visible = true;
    } else {
        Object.assign(display, { routeGroup: '', routeGroupLabel: '', routeGroupAlways: false, routeOrder: 0 });
        delete display.routeGroupDescription;
        delete display.routeGroupScope;
    }
    entry.presentation = display;
    if (group && targetId) {
        const members = group.entries.filter(model => model.id !== id);
        members.splice(members.findIndex(model => model.id === targetId) + (placement === 'after' ? 1 : 0), 0, entry);
        members.forEach((model, index) => { model.presentation = { ...model.presentation, routeOrder: index }; });
    }
    return normalizeCatalogWorkspace(next);
}

export function createCatalogGroup(config, id, label, kind = 'video') {
    const next = copy(config);
    const entry = id ? requireEntry(next, id) : null;
    kind = entry?.kind || kind;
    if (!['image', 'video', 'text'].includes(kind)) throw new Error('请选择分组类型');
    const title = String(label || '').trim();
    if (!title || title.length > 100) throw new Error('分组名需要 1 到 100 个字符');
    const groups = catalogGroups(next, { includeEmpty: true });
    if (groups.some(group => group.kind === kind && group.id && group.label === title)) {
        throw new Error('同类型中已有这个分组名');
    }
    let index = 1;
    let groupId = `group-${next.models.length}`;
    while (groups.some(group => group.id === groupId)) groupId = `group-${next.models.length}-${++index}`;
    rememberCatalogGroup(next, { id: groupId, kind, label: title,
        order: Math.max(-1, ...groups.map(group => group.order)) + 1, entries: [] });
    return entry ? moveCatalogModel(next, id, `${kind}:${groupId}`) : next;
}

export function groupCatalogModel(config, id) {
    const entry = requireEntry(config, id);
    const groups = catalogGroups(config, { kind: entry.kind, includeEmpty: true });
    const current = groups.find(group => group.key === catalogGroupKey(entry));
    if (current?.id && current.totalCount === 1) return copy(config);
    const base = String(name(entry)).trim().slice(0, 100);
    let title = base;
    let index = 1;
    while (groups.some(group => group.id && group.label === title)) {
        const suffix = ` (${++index})`;
        title = base.slice(0, 100 - suffix.length) + suffix;
    }
    return createCatalogGroup(config, id, title);
}

export function renameCatalogGroup(config, groupKey, label) {
    const title = String(label || '').trim();
    if (!title || title.length > 100) throw new Error('分组名需要 1 到 100 个字符');
    const next = copy(config);
    const groups = catalogGroups(next, { includeEmpty: true });
    const group = groups.find(group => group.key === groupKey && group.id);
    if (!group) throw new Error('请选择一个分组');
    if (groups.some(item => item.id && item.key !== groupKey && item.kind === group.kind && item.label === title)) {
        throw new Error('同类型中已有这个分组名');
    }
    for (const entry of group.entries) entry.presentation = { ...entry.presentation, routeGroupLabel: title };
    rememberCatalogGroup(next, { ...group, label: title });
    return next;
}

export function deleteCatalogGroup(config, groupKey) {
    const group = catalogGroups(config, { includeEmpty: true }).find(group => group.key === groupKey && group.id);
    if (!group) throw new Error('请选择一个分组');
    let next = copy(config);
    for (const entry of group.entries) next = moveCatalogModel(next, entry.id, '');
    next.catalogGroups = (next.catalogGroups || []).filter(item => `${item.kind}:${item.id}` !== groupKey);
    return next;
}

export function reorderCatalogGroup(config, groupKey, direction) {
    const all = catalogGroups(config, { includeEmpty: true });
    const selected = all.find(group => group.key === groupKey && group.id);
    if (!selected) throw new Error('请选择一个分组');
    const groups = all.filter(group => group.kind === selected.kind && group.id);
    const index = groups.findIndex(group => group.key === groupKey);
    const target = index + (direction < 0 ? -1 : 1);
    if (target < 0 || target >= groups.length) return copy(config);
    return placeCatalogGroup(config, groupKey, groups[target].key, direction < 0 ? 'before' : 'after');
}

export function placeCatalogGroup(config, groupKey, targetKey, placement = 'before') {
    const next = copy(config);
    const all = catalogGroups(next, { includeEmpty: true });
    const selected = all.find(group => group.key === groupKey && group.id);
    const target = all.find(group => group.key === targetKey && group.id);
    if (!selected || !target) throw new Error('拖动的分组或目标分组已不存在');
    if (selected.kind !== target.kind) throw new Error('分组只能在相同类型中排序');
    if (groupKey === targetKey) return next;
    const groups = all.filter(group => group.kind === selected.kind && group.id && group.key !== groupKey);
    groups.splice(groups.findIndex(group => group.key === targetKey) + (placement === 'after' ? 1 : 0), 0, selected);
    const positions = groups.map(group => group.order).sort((a, b) => a - b);
    groups.forEach((group, index) => {
        group.order = Math.max(positions[index], index ? groups[index - 1].order + 1 : positions[index]);
        group.entries.forEach(model => { model.presentation = { ...model.presentation, routeGroupOrder: group.order }; });
        rememberCatalogGroup(next, group);
    });
    return next;
}

export function reorderCatalog(config, id, direction, scope = 'model') {
    const next = copy(config);
    const entry = requireEntry(next, id);
    const groups = catalogGroups(next, { kind: entry.kind });
    const groupIndex = groups.findIndex(group => group.key === catalogGroupKey(entry));
    const group = groups[groupIndex];
    const items = scope === 'group' || !group.id ? groups : group.entries;
    const index = items === groups ? groupIndex : items.findIndex(item => item.id === id);
    const target = index + (direction < 0 ? -1 : 1);
    if (target < 0 || target >= items.length) return next;
    [items[index], items[target]] = [items[target], items[index]];
    if (items === groups) items.forEach((item, index) => item.entries.forEach(model => {
        model.presentation = { ...model.presentation, routeGroupOrder: index };
    }));
    else items.forEach((model, index) => { model.presentation = { ...model.presentation, routeOrder: index }; });
    return next;
}

export function toggleCatalogVisibility(config, id) {
    const next = copy(config);
    const entry = requireEntry(next, id);
    const visible = entry.presentation?.visible === false;
    entry.presentation = { ...entry.presentation, visible };
    return next;
}

export function setCatalogEnabled(config, id, enabled) {
    const next = copy(config);
    const entry = requireEntry(next, id);
    if (!entry.catalog) throw new Error('请先补全模型 ID 和 API 主机名');
    if (typeof enabled !== 'boolean') throw new Error('调用状态需要启用或停用');
    entry.catalog.enabled = enabled;
    return next;
}

export function deleteCatalogModel(config, id) {
    requireEntry(config, id);
    const next = copy(config);
    rememberCatalogGroup(next, catalogGroups(next).find(group => group.entries.some(entry => entry.id === id)));
    next.models = next.models.filter(entry => entry.id !== id);
    return next;
}

export function createCatalogHistory(initial, limit = 60) {
    let states = [copy(initial)];
    let cursor = 0;
    return {
        push(next) {
            if (JSON.stringify(states[cursor]) === JSON.stringify(next)) return;
            states = states.slice(0, cursor + 1);
            states.push(copy(next));
            if (states.length > limit) states.shift();
            cursor = states.length - 1;
        },
        undo() { if (cursor > 0) cursor--; return copy(states[cursor]); },
        redo() { if (cursor < states.length - 1) cursor++; return copy(states[cursor]); },
        get canUndo() { return cursor > 0; },
        get canRedo() { return cursor < states.length - 1; }
    };
}
