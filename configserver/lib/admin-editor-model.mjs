export const DISPLAY_FIELDS = [
    { key: 'label', label: '显示名称', max: 100 },
    { key: 'description', label: '模型简介', max: 500, multiline: true },
    { key: 'routeLabel', label: '线路名称', max: 80 },
    { key: 'routeGroup', label: '线路分组 ID', max: 100 },
    { key: 'routeGroupLabel', label: '分组卡片标题', max: 100 },
    { key: 'routeModelLabel', label: '线路模型别名', max: 100 }
];

const PRICE_FIELDS = ['priceMode', 'hosts', 'amount', 'currency', 'unit', 'source'];

// 时长约束的形态，与 shared/schemas/model-config.schema.json 的 constraint 定义对齐。
// 刻意暴露类型选择器而不是只给两个数字框：把「固定 30 秒」悄悄变成区间是语义变更，不是数值调整。
export const DURATION_MODES = ['none', 'fixed', 'range', 'enum', 'unsupported', 'unknown'];
// 'other' 不是可构建的形态：它代表「现有约束是 schema 允许、但本表单不编辑的类型」（例如 tier）。
// 单独留一个态是为了不把这种约束显示成「不声明」——那会在运营碰到时长时把它静默删掉。
export const DURATION_PRESERVED = 'other';
const DURATION_FIELDS = ['durationMode', 'durationValue', 'durationMin', 'durationMax',
    'durationDefault', 'durationValues', 'durationInteger', 'durationAllowAuto', 'durationNote'];
// 重建约束时按类型原样带过的字段，避免归一化顺手丢掉我们不编辑的声明。
const DURATION_PASSTHROUGH = { enum: ['labels', 'field'], range: ['step', 'field'], fixed: ['field'],
    unsupported: ['field'], unknown: ['field'] };

export const REFERENCE_KINDS = [
    { key: 'referenceImages', label: '参考图', unit: '张', kinds: ['image', 'video'], bytes: true },
    { key: 'referenceVideos', label: '参考视频', unit: '个', kinds: ['video'] },
    { key: 'referenceAudios', label: '参考音频', unit: '个', kinds: ['video'] }
];
export const REFERENCE_MODES = ['none', 'supported', 'unsupported'];
const referenceFieldsOf = key => [`${key}Mode`, `${key}Max`, `${key}Bytes`, `${key}Note`];

export const PARAM_FIELDS = [...DURATION_FIELDS, ...REFERENCE_KINDS.flatMap(kind => referenceFieldsOf(kind.key))];

const MAX_SECONDS = 3600;
const MAX_REFERENCE_COUNT = 1000;
const MAX_REFERENCE_MEGABYTES = 1024;
const MAX_NOTE_LENGTH = 200;
const BYTES_PER_MEGABYTE = 1024 * 1024;

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const trimmed = value => String(value ?? '').trim();

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

function readDurationValues(entry) {
    const constraint = entry.options?.duration;
    // 三态：没有约束 → none；表单能编辑的类型 → 该类型；其余（如 tier）→ other，原样保留。
    const mode = !constraint ? 'none'
        : (DURATION_MODES.includes(constraint.type) ? constraint.type : DURATION_PRESERVED);
    const numeric = value => (value === undefined || value === null ? '' : String(value));
    return {
        durationMode: mode,
        durationValue: mode === 'fixed' ? numeric(constraint.value) : '',
        durationMin: mode === 'range' ? numeric(constraint.min) : '',
        durationMax: mode === 'range' ? numeric(constraint.max) : '',
        durationDefault: ['range', 'enum'].includes(mode) ? numeric(constraint.default) : '',
        durationValues: mode === 'enum' && Array.isArray(constraint.values) ? constraint.values.join(', ') : '',
        durationInteger: mode === 'range' ? String(constraint.integer !== false) : 'true',
        durationAllowAuto: mode === 'enum' ? String(constraint.allowAuto === true) : 'false',
        // 支持态用 note 描述边界，不支持/未确认态用 reason 说明原因，两者共用一个输入框。
        durationNote: ['unsupported', 'unknown'].includes(mode)
            ? trimmed(constraint.reason) : trimmed(constraint?.note)
    };
}

function readReferenceValues(entry, kind) {
    const declared = entry.capabilities?.[kind.key];
    const mode = declared?.supported === true ? 'supported' : (declared?.supported === false ? 'unsupported' : 'none');
    const values = {
        [`${kind.key}Mode`]: mode,
        [`${kind.key}Max`]: mode === 'supported' && Number.isFinite(Number(declared.max)) ? String(declared.max) : ''
    };
    // Only images carry a byte budget in CONFIG today; emitting the key for other kinds would
    // describe a control that does not exist. Kept in sync with the markup via kind.bytes.
    if (kind.bytes) {
        const bytes = Number(declared?.maxBytesPerImage);
        values[`${kind.key}Bytes`] = mode === 'supported' && Number.isFinite(bytes)
            ? String(Math.round(bytes / BYTES_PER_MEGABYTE)) : '';
    }
    values[`${kind.key}Note`] = mode === 'unsupported' ? trimmed(declared.reason) : trimmed(declared?.note);
    return values;
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
        updatedAt: price.updatedAt || '',
        ...readDurationValues(entry),
        ...REFERENCE_KINDS.reduce((values, kind) => Object.assign(values, readReferenceValues(entry, kind)), {})
    };
}

function parseSeconds(raw, label, { integer = false } = {}) {
    const text = trimmed(raw);
    const value = Number(text);
    if (!text || !Number.isFinite(value) || value < 0 || value > MAX_SECONDS) {
        throw new Error(`${label}需要 0 到 ${MAX_SECONDS} 之间的秒数`);
    }
    if (integer && !Number.isInteger(value)) throw new Error(`${label}需要整数秒`);
    return value;
}

function checkNote(text, label) {
    if (text.length > MAX_NOTE_LENGTH) throw new Error(`${label}最多 ${MAX_NOTE_LENGTH} 个字符`);
    return text;
}

// null 表示「移除该约束」，DURATION_PRESERVED 表示「原样带回」。字段顺序与既有配置保持一致，
// 未改动的条目仍能逐字节回写。
function buildDurationConstraint(previous, values) {
    const mode = values.durationMode;
    // 表单不编辑的类型（如 tier）：原样保留，绝不因为一次无关编辑就删掉它。
    if (mode === DURATION_PRESERVED) {
        if (!object(previous)) throw new Error('时长约束已丢失，请切回 JSON 视图确认');
        return structuredClone(previous);
    }
    if (!DURATION_MODES.includes(mode)) throw new Error('请选择有效的时长约束类型');
    if (mode === 'none') return null;
    const text = checkNote(trimmed(values.durationNote), '时长说明');
    const carry = previous?.type === mode ? DURATION_PASSTHROUGH[mode] || [] : ['field'];
    const scope = Object.fromEntries(carry.filter(key => previous?.[key] !== undefined).map(key => [key, previous[key]]));
    if (mode === 'unsupported' || mode === 'unknown') {
        return { type: mode, ...scope, ...(text ? { reason: text } : {}) };
    }
    const note = text ? { note: text } : {};
    if (mode === 'fixed') {
        return { type: 'fixed', value: parseSeconds(values.durationValue, '固定时长'), unit: 'second', ...scope, ...note };
    }
    if (mode === 'range') {
        const integer = values.durationInteger !== 'false';
        const min = parseSeconds(values.durationMin, '最短时长', { integer });
        const max = parseSeconds(values.durationMax, '最长时长', { integer });
        if (min > max) throw new Error('最短时长不能大于最长时长');
        const constraint = { type: 'range', min, max, integer, unit: 'second', ...scope };
        const preset = trimmed(values.durationDefault);
        if (preset) {
            const value = parseSeconds(preset, '默认时长', { integer });
            if (value < min || value > max) throw new Error('默认时长必须落在最短与最长时长之间');
            constraint.default = value;
        }
        return { ...constraint, ...note };
    }
    const list = [...new Set(trimmed(values.durationValues).split(/[\s,;，；]+/).filter(Boolean)
        .map(item => parseSeconds(item, '可选时长')))].sort((left, right) => left - right);
    if (!list.length) throw new Error('可选时长至少需要一个秒数');
    // enum 不带 unit：schema 未声明该字段，describeConstraint 的 enum 分支也不读它。
    const constraint = { type: 'enum', values: list, allowAuto: values.durationAllowAuto === 'true', ...scope };
    const preset = trimmed(values.durationDefault);
    if (preset) {
        const value = parseSeconds(preset, '默认时长');
        if (!list.includes(value)) throw new Error('默认时长必须是可选时长之一');
        constraint.default = value;
    }
    return { ...constraint, ...note };
}

function buildReferenceCapability(previous, kind, values) {
    const mode = values[`${kind.key}Mode`];
    if (!REFERENCE_MODES.includes(mode)) throw new Error(`请选择有效的${kind.label}支持状态`);
    if (mode === 'none') return null;
    const text = checkNote(trimmed(values[`${kind.key}Note`]), `${kind.label}说明`);
    if (mode === 'unsupported') return { supported: false, ...(text ? { reason: text } : {}) };
    const capability = { supported: true };
    // min / params 不在表单里，但明确声明过就必须原样带回，不能因为编辑数量上限而丢掉。
    for (const key of ['min', 'params']) {
        if (previous?.supported === true && previous[key] !== undefined) capability[key] = previous[key];
    }
    const max = trimmed(values[`${kind.key}Max`]);
    if (max) {
        const count = Number(max);
        if (!Number.isInteger(count) || count < 0 || count > MAX_REFERENCE_COUNT) {
            throw new Error(`${kind.label}数量上限需要 0 到 ${MAX_REFERENCE_COUNT} 的整数`);
        }
        capability.max = count;
    }
    if (kind.bytes) {
        const bytes = trimmed(values[`${kind.key}Bytes`]);
        if (bytes) {
            const megabytes = Number(bytes);
            if (!Number.isInteger(megabytes) || megabytes < 1 || megabytes > MAX_REFERENCE_MEGABYTES) {
                throw new Error(`${kind.label}单张体积上限需要 1 到 ${MAX_REFERENCE_MEGABYTES} MB 的整数`);
            }
            capability.maxBytesPerImage = megabytes * BYTES_PER_MEGABYTE;
        }
    }
    if (text) capability.note = text;
    return capability;
}

function applyPricing(next, entry, values, now) {
    if (values.priceMode === 'inherit') {
        delete next.pricing;
        return;
    }
    if (!['known', 'unknown'].includes(values.priceMode)) throw new Error('请选择有效的售价状态');
    const hosts = [...new Set(String(values.hosts || '').split(/[\s,;，；]+/).filter(Boolean).map(value => value.toLowerCase()))];
    if (!hosts.length || hosts.some(host => host.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host))) {
        throw new Error('适用 API 域名不能为空，且不能包含协议、路径或通配符');
    }
    if (values.priceMode === 'unknown') {
        next.pricing = { status: 'unknown', hosts };
        return;
    }
    const amount = Number(values.amount);
    if (!trimmed(values.amount) || !Number.isFinite(amount) || amount < 0 || amount > 1000000) {
        throw new Error('请输入有效的展示售价，范围为 0 到 1000000');
    }
    if (!['CNY', 'USD'].includes(values.currency)) throw new Error('币种只支持人民币 CNY 或美元 USD');
    if (!['request', 'image', 'second'].includes(values.unit)) throw new Error('请选择按次、按张或按秒计价');
    const source = trimmed(values.source);
    if (!source || source.length > 200) throw new Error('价格来源需要 1 到 200 个字符');
    const previous = entry.pricing;
    const price = { ...(previous?.status === 'known' ? previous : {}), status: 'known', hosts,
        amount, currency: values.currency, unit: values.unit, kind: 'sale', source };
    const changed = ['status', 'hosts', 'amount', 'currency', 'unit', 'kind', 'source']
        .some(key => JSON.stringify(price[key]) !== JSON.stringify(previous?.[key]));
    price.updatedAt = changed ? now : previous.updatedAt;
    next.pricing = price;
}

// Patch only touched controls. Unknown fields and untouched generation parameters stay intact.
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

    if (DURATION_FIELDS.some(key => touched.has(key))) {
        const constraint = buildDurationConstraint(entry.options?.duration, values);
        const options = { ...next.options };
        if (constraint) options.duration = constraint;
        else delete options.duration;
        if (Object.keys(options).length) next.options = options;
        else delete next.options;
    }
    for (const kind of REFERENCE_KINDS) {
        if (!referenceFieldsOf(kind.key).some(key => touched.has(key))) continue;
        const capability = buildReferenceCapability(entry.capabilities?.[kind.key], kind, values);
        const capabilities = { ...next.capabilities };
        if (capability) capabilities[kind.key] = capability;
        else delete capabilities[kind.key];
        if (Object.keys(capabilities).length) next.capabilities = capabilities;
        else delete next.capabilities;
    }

    if (PRICE_FIELDS.some(key => touched.has(key))) applyPricing(next, entry, values, now);
    return next;
}
