import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModelRequest, formatModelRequestIssues } from './model-config-ui.js';

test('checkModelRequest 给出可展示的中文拦截文案', () => {
    const blocked = checkModelRequest({
        provider: { model: 'sd2.5-route1' },
        kind: 'video',
        prompt: '一只猫',
        fields: { duration: 20 }
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.errors.length, 1);
    assert.match(blocked.message, /固定为 30/);

    const passed = checkModelRequest({
        provider: { model: 'sd2.5-route1' },
        kind: 'video',
        prompt: '一只猫',
        fields: { duration: 30, ratio: '16:9' },
        references: { image: { count: 3 } }
    });
    assert.equal(passed.ok, true);
    assert.equal(passed.message, '');
});

test('未收录模型只提示不拦截', () => {
    const result = checkModelRequest({
        provider: { model: 'my-private-model' },
        kind: 'video',
        prompt: '一只猫',
        fields: { duration: 999 }
    });
    assert.equal(result.ok, true);
    assert.equal(result.matched, false);
    assert.match(formatModelRequestIssues(result), /未收录在模型配置中/);
});
