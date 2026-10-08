const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateGenerationHealth, createGenerationHealthReader } = require('../server/relay-error-gateway/generation-health.cjs');
const now = Date.parse('2026-09-29T10:00:00Z');
const iso = offset => new Date(now + offset).toISOString();
function row(key, overrides = {}) {
    return { key, sequence: 1, model: 'video-test', createdAt: iso(-600000), statusCode: 200,
        completed: true, async: true, kind: 'video', latencyMs: 15,
        response: { states: ['completed'], completedAt: iso(-300000) }, ...overrides };
}
function aggregate(records, options) { return aggregateGenerationHealth({ records }, { now, ...options }).models[0]; }

test('deduplicates task records and measures actual completion including queue time', () => {
    const result = aggregate([row('a', { sequence: 0, completed: false, response: { states: ['queued'] } }), row('a'), row('b'), row('c')]);
    assert.equal(result.successCount, 3);
    assert.equal(result.state, 'available');
    assert.equal(result.averageSeconds, 300);
    assert.deepEqual(result.sampleDurationsSeconds, [300, 300, 300]);
});
test('accepted, pending and unresolved timeouts never count as completed generation', () => {
    const result = aggregate([
        row('a', { response: { states: ['queued'] } }), row('b', { completed: false }),
        row('c', { statusCode: 500, response: { states: ['in_progress'] }, error: 'timeout' }),
        row('d', { statusCode: 202, response: { hasOutput: true } })]);
    assert.equal(result.successCount, 0);
    assert.equal(result.failureCount, 0);
    assert.equal(result.averageSeconds, null);
    assert.deepEqual(result.samples, ['unknown', 'unknown', 'unknown', 'unknown']);
});
test('customer errors and moderation are excluded; service failures remain red', () => {
    const result = aggregate([
        ...[[400, 'invalid parameter'], [402, 'insufficient balance'], [401, 'invalid api key'], [500, 'content policy rejected']]
            .map(([statusCode, error], i) => row(`exclude-${i}`, { statusCode, error, response: { states: ['failed'] } })),
        row('server', { statusCode: 503, error: 'service unavailable', response: { states: ['failed'] } }), row('success'), row('success2')]);
    assert.equal(result.excludedCount, 4);
    assert.equal(result.failureCount, 1);
    assert.equal(result.state, 'degraded');
});
test('missing async completion timestamp is not replaced by HTTP or output duration', () => {
    const result = aggregate([row('a', { response: { states: ['completed'] }, latencyMs: 99 })]);
    assert.equal(result.successCount, 1);
    assert.equal(result.averageSeconds, null);
    assert.equal(result.state, 'unknown');
    assert.deepEqual(result.sampleDurationsSeconds, [null]);
});
test('sync image latency is usable only when output exists and task is complete', () => {
    const result = aggregate([row('a', { kind: 'image', async: false, latencyMs: 65000, response: { hasOutput: true } })]);
    assert.equal(result.averageSeconds, 65);
});

test('verified terminal relay elapsed time supplies video duration without accepting HTTP latency', () => {
    const record = row('terminal', { response: { states: ['completed'] }, latencyMs: 19,
        completionTimeSource: 'relay_terminal_elapsed', completionElapsedMs: 405916 });
    const result = aggregate([record]);
    assert.equal(result.averageSeconds, 406);
    assert.deepEqual(result.sampleDurationsSeconds, [405.916]);
    assert.equal(result.state, 'unknown');
    assert.equal(result.reason, 'insufficient');
    assert.equal(aggregate([{ ...record, completionTimeSource: 'http' }]).averageSeconds, null);
    assert.equal(aggregate([{ ...record, completionElapsedMs: 99999999 }]).averageSeconds, null);
    assert.equal(aggregate([{ ...record, response: { states: ['queued'] } }]).averageSeconds, null);
    assert.equal(aggregate([{ ...record, response: { states: ['completed'], completedAt: iso(-300000) } }]).averageSeconds, 300);
});
test('old evidence and insufficient samples are gray; sites/models never mix', () => {
    const result = aggregate(['a', 'b', 'c'].map(key => row(key, { createdAt: iso(-8 * 3600000), response: { states: ['completed'] } })));
    assert.equal(result.state, 'unknown');
    assert.equal(result.reason, 'stale');
    assert.equal(aggregateGenerationHealth({ records: [row('a'), row('a', { model: 'other' })] }, { now }).models.length, 2);
});
test('poll traffic shares one cached read; private fields never enter aggregate', async () => {
    let reads = 0;
    const reader = createGenerationHealthReader({ now: () => now, readRecords: async () => {
        reads++; return { records: [row('a', { apiKey: 'secret', prompt: 'private', cost: 19 })] };
    } });
    const results = await Promise.all([reader.get(), reader.get(), reader.get()]);
    await reader.get();
    assert.equal(reads, 1);
    assert.doesNotMatch(JSON.stringify(results), /secret|private|cost|apiKey/);
});
