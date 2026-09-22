const copy = value => structuredClone(value);
const name = entry => (entry.presentation?.routeGroup && entry.presentation?.routeLabel)
    || entry.presentation?.label || entry.label || entry.catalog?.model || entry.id;
const order = (value, fallback) => Number.isInteger(value) ? value : fallback;
export const modelName = name;
export const modelVisible = entry => entry.presentation?.visible !== false && entry.catalog?.enabled !== false;
export const catalogGroupKey = entry => entry.presentation?.routeGroup
    ? `${entry.kind}:${entry.presentation.routeGroup}` : `model:${entry.id}`;

export function catalogModelPrice(entry) {
    const pricing = entry?.pricing;
    if (!Array.isArray(pricing?.hosts) || !pricing.hosts.some(host => typeof host === 'string'
        && host.toLowerCase() === 'art.ravenhash.org')) return '老站价格：未配置';
    if (pricing.status === 'unknown') return '老站价格：待确认';
    const units = { request: '次', second: '秒', image: '张' };
    if (pricing.status !== 'known' || pricing.kind !== 'sale' || !Number.isFinite(pricing.amount)
        || pricing.amount < 0 || !['CNY', 'USD'].includes(pricing.currency)
        || !Object.hasOwn(units, pricing.unit)) return '老站价格：待确认';
    const amount = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(pricing.amount);
    return `老站价格：${pricing.currency === 'CNY' ? '¥' : 'US$'}${amount}/${units[pricing.unit]}`;
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

export function catalogGroups(config, { kind = '', query = '', includeHidden = true, includeDisabled = false, includeLegacy = true } = {}) {
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
    const normalized = String(query).trim().toLowerCase();
    return [...groups.values()].map(group => {
        const members = group.entries.sort((a, b) => order(a.entry.presentation?.routeOrder, 0)
            - order(b.entry.presentation?.routeOrder, 0)
            || ((a.entry.presentation?.routeLabel || '') < (b.entry.presentation?.routeLabel || '') ? -1
                : (a.entry.presentation?.routeLabel || '') > (b.entry.presentation?.routeLabel || '') ? 1 : 0)
            || a.index - b.index).map(item => item.entry);
        const entries = members.filter(entry => includeHidden || (entry.presentation?.visible !== false
            && (includeDisabled || entry.catalog?.enabled !== false)));
        const disabledCount = members.filter(entry => entry.catalog?.enabled === false).length;
        return { ...group, entries, disabledCount, totalCount: members.length,
            disabled: disabledCount === members.length, order: order(entries[0]?.presentation?.routeGroupOrder, 0) };
    }).filter(group => group.entries.length).sort((a, b) => a.order - b.order || a.index - b.index)
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

export function moveCatalogModel(config, id, groupKey) {
    const next = copy(config);
    const entry = requireEntry(next, id);
    const group = catalogGroups(next).find(group => group.key === groupKey && group.id);
    if (groupKey && !group) throw new Error('目标分组已不存在');
    if (group && group.kind !== entry.kind) throw new Error('模型只能移动到相同类型的分组');
    const display = { ...entry.presentation };
    if (group) {
        const template = group.entries[0].presentation;
        Object.assign(display, { routeGroup: group.id, routeGroupLabel: group.label,
            routeLabel: display.routeLabel || name(entry),
            routeGroupScope: template.routeGroupScope || 'catalog', routeGroupAlways: true,
            routeGroupOrder: group.order,
            routeOrder: Math.max(...group.entries.map(model => order(model.presentation?.routeOrder, 0))) + 1 });
    } else {
        Object.assign(display, { routeGroup: '', routeGroupLabel: '', routeGroupAlways: false, routeOrder: 0 });
    }
    entry.presentation = display;
    return next;
}

export function createCatalogGroup(config, id, label) {
    const next = copy(config);
    const entry = requireEntry(next, id);
    const title = String(label || '').trim();
    if (!title || title.length > 100) throw new Error('分组名需要 1 到 100 个字符');
    if (catalogGroups(next).some(group => group.kind === entry.kind && group.id && group.label === title)) {
        throw new Error('同类型中已有这个分组名');
    }
    let index = 1;
    let groupId = `group-${next.models.length}`;
    while (next.models.some(model => model.presentation?.routeGroup === groupId)) groupId = `group-${next.models.length}-${++index}`;
    entry.presentation = { ...entry.presentation, routeGroup: groupId, routeGroupLabel: title,
        routeLabel: entry.presentation?.routeLabel || name(entry),
        routeGroupScope: 'catalog', routeGroupAlways: true,
        routeGroupOrder: Math.max(-1, ...catalogGroups(next).map(group => group.order)) + 1, routeOrder: 0 };
    return next;
}

export function renameCatalogGroup(config, groupKey, label) {
    const title = String(label || '').trim();
    if (!title || title.length > 100) throw new Error('分组名需要 1 到 100 个字符');
    const next = copy(config);
    const group = catalogGroups(next).find(group => group.key === groupKey && group.id);
    if (!group) throw new Error('请选择一个分组');
    for (const entry of group.entries) entry.presentation = { ...entry.presentation, routeGroupLabel: title };
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

export function deleteCatalogModel(config, id) {
    requireEntry(config, id);
    return { ...copy(config), models: config.models.filter(entry => entry.id !== id).map(copy) };
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
