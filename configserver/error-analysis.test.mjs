import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createErrorAnalysis, validateAnalysis, analysisEndpoint } from './lib/error-analysis.mjs';

const text = 'Image pixel format YUV422 is not supported; expected RGB.';
const answer = { cause: '图片像素格式不兼容,需要检查颜色格式', evidence: text, suggestion: 'check_reference', confidence: 0.95 };
const token = digit => `ea_${digit.repeat(32)}`;
function setup(t, callApi, rows = [{ id: 'a', input: text }, { id: 'b', input: text }]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-error-analysis-'));
    const requestDiagnostics = { async get(site, id, options) {
        if (site === 'cart') return { status: 200, body: { record: { records: [] } } };
        if (options?.review) return { status: 200, body: { record: { records: rows.map(row => ({ requestId: row.id, analysisId: token(row.id) })) } } };
        const row = rows.find(row => row.id === id);
        return { status: 200, body: { record: { records: [{ requestId: id, analysisInput: row.input,
            publicError: { analysisId: token(id) }, analysisScope: row.scope || 'same-channel' }] } } };
    } };
    const create = () => createErrorAnalysis({ dataDir, requestDiagnostics, callApi });
    const service = create();
    t.after(async () => { await service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const configure = extra => service.configure({ enabled: true, endpoint: 'https://api.example.com/v1', model: 'test-model', apiKey: 'secret-test-key', dailyLimit: 50, ...extra });
    return { dataDir, service, configure, create };
}

test('identical errors share one invocation, persist across restart, and publish only checked advice', async t => {
    let calls = 0;
    const f = setup(t, async (_settings, input) => { calls++; assert.equal(input, text); return answer; });
    f.configure(); await Promise.all([f.service.cycle(), f.service.cycle()]);
    assert.equal(calls, 1);
    assert.deepEqual(f.service.lookup(token('a')), f.service.lookup(token('b')));
    assert.equal(f.service.lookup(token('a')).state, 'ready');
    assert.doesNotMatch(JSON.stringify(f.service.lookup(token('a'))), /secret|analysisScope|same-channel|api\.example/);
    const restarted = f.create(); await restarted.cycle(); await restarted.close(); assert.equal(calls, 1);
});
test('different limits/channels are not merged, empty evidence is not sent, and daily quota bounds spend', async t => {
    let calls = 0;
    const f = setup(t, async () => { calls++; return answer; }, [
        { id: 'a', input: text }, { id: 'b', input: text, scope: 'different-channel' },
        { id: 'c', input: '' }, { id: 'd', input: text + ' width 256' }
    ]);
    f.configure({ dailyLimit: 1 }); await f.service.cycle();
    assert.equal(calls, 1);
    assert.equal(f.service.list().length, 4);
    assert.equal(f.service.lookup(token('c')).state, 'unavailable');
    await f.service.cycle(); assert.equal(calls, 1);
});
test('credentials are never returned and disabled automation makes no API calls', async t => {
    let calls = 0;
    const f = setup(t, async () => { calls++; return answer; });
    f.configure({ enabled: false }); await f.service.cycle(); assert.equal(calls, 0);
    assert.doesNotMatch(JSON.stringify(f.service.viewSettings()), /secret-test-key/);
    f.configure({ apiKey: '' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'error-analysis-settings.json'))).apiKey, 'secret-test-key');
    assert.throws(() => f.configure({ clearKey: true }), /Key/);
});
test('untrusted AI output cannot invent numbers, leak credentials or change billing/submission instructions', () => {
    assert.ok(validateAnalysis(answer, text));
    for (const value of [{ ...answer, cause: '宽度必须为1024像素' }, { ...answer, cause: '任务已经退款,请重新提交' },
        { ...answer, evidence: 'unrelated fabricated evidence' }, { ...answer, confidence: 0.5 },
        { ...answer, cause: '联系 https://private.example/' }, { ...answer, status: 'success' },
        { ...answer, cause: '更换凭据 sk-private-secret' }]) assert.equal(validateAnalysis(value, text), null);
});
test('analysis endpoints are HTTPS public domains with predictable protocol paths', () => {
    assert.equal(analysisEndpoint('https://api.example.com/v1', 'responses'), 'https://api.example.com/v1/responses');
    for (const url of ['http://api.example.com', 'https://127.0.0.1/v1', 'https://localhost/v1', 'https://user:password@api.example.com/v1', 'https://api.example.com/v1?key=secret']) assert.throws(() => analysisEndpoint(url));
});

test('corrupted persistent counters stop automatic calls instead of resetting the budget', async t => {
    let calls = 0;
    const f = setup(t, async () => { calls++; return answer; }); f.configure();
    fs.writeFileSync(path.join(f.dataDir, 'error-analysis-state.json'), '{broken');
    const service = f.create(); await service.cycle();
    assert.equal(calls, 0); assert.equal(service.viewSettings().storageHealthy, false);
    await service.close();
});
