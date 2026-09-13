export const DISPLAY_FIELDS = [
    { key: 'label', label: '显示名称', max: 100 },
    { key: 'description', label: '模型简介', max: 500, multiline: true },
    { key: 'routeLabel', label: '线路名称', max: 80 },
    { key: 'routeGroup', label: '线路分组 ID', max: 100 },
    { key: 'routeGroupLabel', label: '分组卡片标题', max: 100 },
    { key: 'routeModelLabel', label: '线路模型别名', max: 100 }
];

const PRICE_FIELDS = ['priceMode', 'hosts', 'amount', 'currency', 'unit', 'source'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function parseEditorConfig(text) {
    const config = JSON.parse(text);
    if (!object(config) || config.schemaVersion !== 1 || !Array.isArray(config.models) || !config.models.length) {
        throw new Error('配置需要 schemaVersion: 1 和非空 models 数组');
    }
    const ids = new Set();
    for (const entry of config.models) {
        if (!object(entry) || typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id)) {
            throw new Error('每个模型需要唯一且非空的 id');
        }
        ids.add(entry.id);
    }
    return config;
}

export function readEditorValues(entry) {
    const display = entry.presentation || {};
    const price = entry.pricing || {};
    return {
        ...Object.fromEntries(DISPLAY_FIELDS.map(({ key }) => [key, display[key] ?? ''])),
        recommended: typeof display.recommended === 'boolean' ? String(display.recommended) : 'inherit',
        priceMode: price.status || 'inherit',
        hosts: Array.isArray(price.hosts) ? price.hosts.join('\n') : '',
        amount: price.amount === undefined ? '' : String(price.amount),
        currency: price.currency || 'CNY', unit: price.unit || 'request', source: price.source || 'config-admin',
        updatedAt: price.updatedAt || ''
    };
}

// Patch only touched controls. Unknown fields and generation parameters stay intact.
export function applyEditorValues(entry, values, touched, now = new Date().toISOString()) {
    const next = structuredClone(entry);
    const display = { ...next.presentation };
    let displayChanged = false;
    for (const field of DISPLAY_FIELDS) {
        if (!touched.has(field.key)) continue;
        const value = String(values[field.key] ?? '').trim();
        if (value.length > field.max) throw new Error(`${field.label}最多 ${field.max} 个字符`);
        if (field.key === 'label' && !value) delete display.label;
        else display[field.key] = value;
        displayChanged = true;
    }
    if (touched.has('recommended')) {
        if (values.recommended === 'inherit') delete display.recommended;
        else if (['true', 'false'].includes(values.recommended)) display.recommended = values.recommended === 'true';
        else throw new Error('请选择有效的推荐状态');
        displayChanged = true;
    }
    if (displayChanged) {
        if (Object.keys(display).length) next.presentation = display;
        else delete next.presentation;
    }
    if (!PRICE_FIELDS.some(key => touched.has(key))) return next;
    if (values.priceMode === 'inherit') {
        delete next.pricing;
        return next;
    }
    if (!['known', 'unknown'].includes(values.priceMode)) throw new Error('请选择有效的售价状态');
    const hosts = [...new Set(String(values.hosts || '').split(/[\s,;，；]+/).filter(Boolean).map(value => value.toLowerCase()))];
    if (!hosts.length || hosts.some(host => host.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host))) {
        throw new Error('适用 API 域名不能为空，且不能包含协议、路径或通配符');
    }
    if (values.priceMode === 'unknown') {
        next.pricing = { status: 'unknown', hosts };
        return next;
    }
    const amount = Number(values.amount);
    if (!String(values.amount ?? '').trim() || !Number.isFinite(amount) || amount < 0 || amount > 1000000) {
        throw new Error('请输入有效的展示售价，范围为 0 到 1000000');
    }
    if (!['CNY', 'USD'].includes(values.currency)) throw new Error('币种只支持人民币 CNY 或美元 USD');
    if (!['request', 'image', 'second'].includes(values.unit)) throw new Error('请选择按次、按张或按秒计价');
    const source = String(values.source || '').trim();
    if (!source || source.length > 200) throw new Error('价格来源需要 1 到 200 个字符');
    const previous = entry.pricing;
    const price = { ...(previous?.status === 'known' ? previous : {}), status: 'known', hosts,
        amount, currency: values.currency, unit: values.unit, kind: 'sale', source };
    const changed = ['status', 'hosts', 'amount', 'currency', 'unit', 'kind', 'source']
        .some(key => JSON.stringify(price[key]) !== JSON.stringify(previous?.[key]));
    price.updatedAt = changed ? now : previous.updatedAt;
    next.pricing = price;
    return next;
}
