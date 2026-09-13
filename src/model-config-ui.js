// 模型配置后台启动与生成请求校验文案。
import { modelConfigStore } from './model-config.js';
import { validateModelRequest } from './model-config-capabilities.js';

// ── 提交前校验 ───────────────────────────────────────────────
/**
 * 校验一次生成请求。返回值里的 `message` 已经是可直接展示的中文文案。
 * 未收录的模型 / 未知边界的警告也会带上，供 UI 以提示方式展示。
 */
export function checkModelRequest({ provider = {}, kind = 'image', fields = {}, features = {}, references = {}, prompt = '', promptResolved = true } = {}) {
    const result = validateModelRequest({
        config: modelConfigStore.getConfig(),
        provider: { ...provider, kind },
        fields,
        features,
        references,
        prompt,
        promptResolved
    });
    return {
        ...result,
        message: formatModelRequestIssues(result)
    };
}

export function formatModelRequestIssues(result) {
    const parts = [];
    for (const item of result?.errors || []) parts.push(item.message);
    for (const item of result?.warnings || []) parts.push(item.message);
    return parts.join('；');
}

export function assertModelRequest(options) {
    const result = checkModelRequest(options);
    if (!result.ok) {
        throw new Error(`当前模型参数不被支持：${result.errors.map(item => item.message).join('；')}`);
    }
    return result;
}

/**
 * 启动后台配置更新。重复调用是安全的。
 * 由 main.js 的 bootstrap 调用一次。
 */
export function initModelConfigUi() {
    modelConfigStore.start();
    return modelConfigStore;
}
