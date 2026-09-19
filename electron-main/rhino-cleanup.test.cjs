const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { RhinoCleanup } = require('./rhino-cleanup.cjs');

function setup(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-cleanup-test-'));
    const job = { id: randomBytes(16).toString('hex') };
    const results = path.join(directory, 'rhino-model-results', job.id);
    fs.mkdirSync(results, { recursive: true });
    fs.writeFileSync(path.join(results, 'import-result.json'), JSON.stringify({ ok: true, jobId: job.id, meshIds: ['source-id'] }));
    const runner = new RhinoCleanup(directory);
    let calls = 0;
    const mcp = { call: async (_name, input) => {
        if (input.action === 'objects') return { content: [{ type: 'text', text: JSON.stringify({ success: true, objects: [{ id: 'output-id' }] }) }] };
        const script = /"([^"]+)"/.exec(input.cmd)[1];
        assert.ok(fs.existsSync(script));
        if (path.basename(script) === 'verify-hunyuan.py') {
            const options = JSON.parse(fs.readFileSync(path.join(path.dirname(script), 'verify-options.json'), 'utf8'));
            fs.writeFileSync(options.resultFile, JSON.stringify({ ok: true, jobId: job.id,
                invocationId: options.invocationId, foundIds: options.expectedIds, documentEmpty: false }));
            return;
        }
        calls++;
        assert.match(input.cmd, /^_-RunPythonScript "[^"\r\n]+cleanup-hunyuan\.py"$/);
        const options = JSON.parse(fs.readFileSync(path.join(path.dirname(script), 'cleanup-options.json'), 'utf8'));
        const result = { ok: true, jobId: job.id, invocationId: options.invocationId, stage: options.stage,
            status: 'completed', outputs: [{ mesh: { id: 'output-id' } }] };
        fs.writeFileSync(path.join(results, `cleanup-${options.stage}.json`), JSON.stringify(result));
    } };
    t.after(() => {
        const scriptDir = path.join(os.tmpdir(), 'corvas-hunyuan-rhino', job.id);
        assert.equal(path.dirname(scriptDir), path.join(os.tmpdir(), 'corvas-hunyuan-rhino'));
        fs.rmSync(scriptDir, { recursive: true, force: true }); fs.rmSync(directory, { recursive: true, force: true });
    });
    return { runner, job, results, mcp, calls: () => calls };
}

test('Rhino cleanup writes a real script and reuses verified completed stage outputs', async t => {
    const h = setup(t);
    assert.equal((await h.runner.execute(h.job, { stage: 'clean' }, h.mcp, 'rhino')).ok, true);
    assert.equal((await h.runner.execute(h.job, { stage: 'clean' }, h.mcp, 'rhino')).reused, true);
    assert.equal(h.calls(), 1);
});

test('an old failed report cannot turn an uncertain Rhino dispatch into a safe replay', async t => {
    const h = setup(t);
    fs.writeFileSync(path.join(h.results, 'cleanup-quad.json'), JSON.stringify({ ok: false, status: 'failed', jobId: h.job.id, invocationId: 'old' }));
    let calls = 0;
    h.mcp.call = async () => { calls++; throw new Error('connection closed'); };
    await assert.rejects(h.runner.execute(h.job, { stage: 'quad' }, h.mcp, 'rhino'), { code: 'MCP_RESULT_UNKNOWN' });
    await assert.rejects(h.runner.execute(h.job, { stage: 'quad' }, h.mcp, 'rhino'), { code: 'MCP_RESULT_UNKNOWN' });
    assert.equal(calls, 1);
});
