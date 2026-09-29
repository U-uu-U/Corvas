import test from 'node:test';
import assert from 'node:assert/strict';
import { withCatalogGenerationHealth, projectHealth } from './lib/catalog-generation-health.mjs';
import { describeGenerationHealth, selectGenerationHealth } from '../shared/model-generation-health.mjs';
const now = Date.parse('2026-09-29T10:00:00Z');
const checkedAt = new Date(now).toISOString();
const metric = { model: 'm', state: 'available', reason: 'recent', samples: ['success', 'success', 'success'],
    successCount: 3, failureCount: 0, excludedCount: 2, durationSamples: 2, averageSeconds: 130,
    validUntil: new Date(now + 180000).toISOString(), lastCompletedAt: checkedAt };

test('public catalog has only explicit summary fields for the exact model/site', () => {
    const config = { models: [{ kind: 'video', catalog: { model: 'm', hosts: ['art.ravenhash.org', 'cart.ravenhash.org'] },
        generationHealth: [{ key: 'injected' }] }] };
    const result = withCatalogGenerationHealth(config, { 'art.ravenhash.org': { checkedAt,
        models: [{ ...metric, credentials: 'secret', price: 5, records: [{ user: 'private' }] }] } }, now);
    const [art, cart] = result.models[0].generationHealth;
    assert.equal(art.state, 'available');
    assert.equal(cart.state, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /secret|price|private|records|injected/);
    assert.deepEqual(selectGenerationHealth(result.models[0], 'https://cart.ravenhash.org/v1'), { ...cart, sampleDurationsSeconds: [] });
    assert.equal(selectGenerationHealth(result.models[0], 'https://art.ravenhash.org.evil/v1'), null);
});
test('cached metrics expire at both server and client; durations stay explicitly unknown', () => {
    assert.equal(projectHealth(metric, checkedAt, now + 180001).state, 'unknown');
    const current = describeGenerationHealth({ ...metric, checkedAt }, now);
    assert.equal(current.duration, '平均 2分10秒');
    const expired = describeGenerationHealth(metric, now + 180001);
    assert.equal(expired.duration, '平均 --');
    assert.ok(expired.samples.every(value => value === 'unknown'));
    assert.equal(describeGenerationHealth(null).duration, '平均 --');
});
test('invalid statistics fail closed and cannot leak extra fields', () => {
    assert.equal(projectHealth({ ...metric, samples: ['secret'] }, checkedAt, now).state, 'unknown');
    assert.equal(projectHealth({ ...metric, averageSeconds: NaN }, checkedAt, now).state, 'unknown');
});

test('per-task durations survive projection without changing the legacy health envelope', () => {
    const config = { models: [{ kind: 'video', catalog: { model: 'm', hosts: ['art.ravenhash.org'] } }] };
    const result = withCatalogGenerationHealth(config, { 'art.ravenhash.org': { checkedAt,
        models: [{ ...metric, sampleDurationsSeconds: [1800, 1800.1, null] }] } }, now);
    const entry = result.models[0];
    assert.equal(Object.hasOwn(entry.generationHealth[0], 'sampleDurationsSeconds'), false);
    const selected = selectGenerationHealth(entry, 'https://art.ravenhash.org/v1');
    assert.deepEqual(selected.sampleDurationsSeconds, [1800, 1800.1, null]);
    const display = describeGenerationHealth(selected, now);
    assert.equal(display.samples.length, 10);
    assert.deepEqual(display.samples.slice(-3), ['success', 'slow', 'success']);
    assert.ok(display.samples.slice(0, 7).every(value => value === 'unknown'));
    assert.ok(describeGenerationHealth(selected, now + 180001).samples.every(value => value === 'unknown'));
    const failed = describeGenerationHealth({ ...selected, samples: ['failure'], sampleDurationsSeconds: [2000] }, now);
    assert.equal(failed.samples.at(-1), 'failure');
});
