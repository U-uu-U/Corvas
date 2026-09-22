import test from 'node:test';
import assert from 'node:assert/strict';

let helpers;
test.before(async () => {
    helpers = await import('./provider-capabilities.js');
});

test('显式用途优先于相同的 RavenHash URL 和模型名推断', () => {
    const endpoint = 'https://ai.ravenhash.org/v1';
    assert.equal(helpers.inferProviderCapability({ endpoint, model: 'gpt-5.5', capability: 'text' }), 'text');
    assert.equal(helpers.inferProviderCapability({ endpoint, model: 'gpt-image-2', capability: 'text' }), 'text');
    assert.equal(helpers.inferProviderCapability({ endpoint, model: 'gpt-5.5', capability: 'image' }), 'image');
});

test('旧配置继续按模型信息推断用途', () => {
    assert.equal(helpers.inferProviderCapability({ model: 'gpt-image-2' }), 'image');
    assert.equal(helpers.inferProviderCapability({ model: 'doubao-seedance-2-0' }), 'video');
    assert.equal(helpers.inferProviderCapability({ model: 'oc-model-qbdmeb', endpoint: 'https://shanhai.vnshu.cn/api/v1' }), 'video');
    assert.equal(helpers.inferProviderCapability({ model: 'ch1401-sd-2.5-720p', endpoint: 'https://api.xzapi.vip/v1' }), 'video');
    assert.equal(helpers.inferProviderCapability({ model: 'shanhai-image-2', endpoint: 'https://shanhai.vnshu.cn/api/v1' }), 'image');
    assert.equal(helpers.inferProviderCapability({ model: 'gpt-5.5' }), 'text');
    assert.equal(helpers.inferProviderCapability({ capability: 'chat' }), 'text');
    assert.equal(helpers.inferProviderCapability({ capability: 'vision' }), 'text');
    assert.equal(helpers.inferProviderCapability({ capability: 'multimodal' }), 'text');
});

test('text execution rejects dedicated generation models without changing saved roles', () => {
    for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'dall-e-3', 'mj_imagine', 'sd2.5-route1', 'minimax-h3', 'oc-model-qbdmeb', 'ch1401-sd-2.5-720p']) {
        const provider = { model, capability: 'text', endpoint: 'https://ai.ravenhash.org/v1' };
        assert.equal(helpers.inferProviderCapability(provider), 'text');
        assert.equal(helpers.canUseTextProvider(provider), false);
        assert.equal(helpers.textProviderError(provider).code, 'TEXT_PROVIDER_REQUIRED');
    }
    for (const model of ['gpt-5.5', 'claude-sonnet', 'qwen-vl', 'custom-vision']) {
        assert.equal(helpers.canUseTextProvider({ model, capability: 'text' }), true);
        assert.equal(helpers.canUseTextProvider({ model, capability: 'image' }), false);
    }
    assert.equal(helpers.canUseTextProvider({ model: 'custom-text', endpoint: 'https://example.test/v1/images/generations' }), true);
    assert.equal(helpers.providerHasCapability(null, 'text'), false);
});

test('Midjourney 图片模型只匹配初始四宫格生成动作', () => {
    assert.equal(helpers.isMidjourneyImageModel('mj_imagine'), true);
    assert.equal(helpers.isMidjourneyImageModel('Midjourney'), true);
    assert.equal(helpers.isMidjourneyImageModel('mj_upscale'), false);
    assert.equal(helpers.isMidjourneyImageModel('gpt-image-2'), false);
});
