const ANNOTATION_KEYS = ['reason', 'note', 'notes', 'description', 'resultsPerRequestNote', 'passRateNote'];

export function splitModelConfigDocumentation(source) {
    const config = structuredClone(source);
    const annotations = [];
    function extract(object, path, modelId = null, keys = ANNOTATION_KEYS) {
        if (!object || typeof object !== 'object' || Array.isArray(object)) return;
        for (const key of keys) {
            if (!Object.hasOwn(object, key)) continue;
            annotations.push({ modelId, path: [...path, key], value: object[key] });
            delete object[key];
        }
    }

    // Visit schema objects only: enum/default values and field names are data.
    extract(config, []);
    for (const vocabulary of ['fields', 'capabilities']) {
        for (const [key, definition] of Object.entries(config[vocabulary] || {})) {
            extract(definition, [vocabulary, key]);
        }
    }
    config.models.forEach((model, index) => {
        const path = ['models', index];
        extract(model, path, model.id);
        for (const group of ['match', 'parameters', 'prompt', 'limits']) {
            extract(model[group], [...path, group], model.id);
        }
        extract(model.limits, [...path, 'limits'], model.id, ['passRate']);
        for (const group of ['options', 'capabilities', 'limits']) {
            for (const [key, definition] of Object.entries(model[group] || {})) {
                extract(definition, [...path, group, key], model.id);
            }
        }
    });
    return { config, annotations };
}

export function renderModelConfigNotes({ config, annotations, exportedAt, configSha256 }) {
    const lines = [
        '# CONFIG 配套说明', '',
        '只修改并发布 `CONFIG.json`。本文件保存原因、备注与实测记录，不参与模型请求或参数限制。', '',
        `导出时间：${exportedAt}。来源：源码内置配置，revision=${config.revision}；不包含线上现行版或客户端缓存。`,
        `CONFIG SHA-256：\`${configSha256}\`。`, '',
        '## 如何使用', '',
        '- `CONFIG.json` 保留全部模型、匹配规则、默认值、枚举、范围、固定值和能力开关；模型数量及参数值没有改动。',
        '- `type: "unknown"` 表示边界未确认，不等于不支持；`type: "unsupported"` 或 `supported: false` 才表示明确不支持。',
        '- 原 `reason`、`note`、`notes`、说明文字和通过率记录移到下面；客户端缺少这些文案时使用内置通用提示。',
        '- 默认更新源为 `https://artconfig.ravenhash.org/config`，管理入口为 `https://artconfig.ravenhash.org/admin`。',
        '- 发布前先备份并比较线上现行版，按整份 CONFIG 校验、保存并应用，再等待客户端后台自动刷新。此次导出没有修改服务器。',
        '- 价格、部分控件默认值与请求适配协议仍有本地实现，单改 JSON 不会全部生效；`limits.concurrency` 不控制全画布并发。',
        '- `model-config.schema.json` 只用于格式校验，`MANIFEST.json` 只用于核对文件；不要把它们当作 CONFIG 发布。', '',
        '## 原始说明', '',
        '以下逐项保留导出前的说明，属于历史依据，不代表本次重新验证了上游能力。', ''
    ];
    const cell = value => (typeof value === 'string' ? value : JSON.stringify(value))
        .replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    for (const model of [null, ...config.models]) {
        const entries = annotations.filter(item => item.modelId === (model?.id ?? null));
        if (!entries.length) continue;
        lines.push(`### ${model ? `${model.label || model.id} (${model.id})` : '公共字段'}`, '',
            '| 原字段 | 说明 |', '| --- | --- |');
        for (const item of entries) {
            const path = model ? item.path.slice(2) : item.path;
            lines.push(`| ${cell(path.join('.'))} | ${cell(item.value)} |`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
