const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GenerationRecoveryStore } = require('./generation-recovery-store.cjs');

test('clear removes finished recovery records but preserves active submissions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-recovery-clear-'));
    try {
        const store = new GenerationRecoveryStore(directory);
        store.update('finished', { kind: 'video', state: 'attached', taskId: 'done' });
        store.update('failed', { kind: 'video', state: 'failed', error: 'bad' });
        store.update('active', { kind: 'video', state: 'recovering', taskId: 'maybe' });
        const result = store.clear({ preserveActive: true });
        assert.deepEqual(new Set(result.removed), new Set(['finished', 'failed']));
        assert.equal(store.get('active').state, 'recovering');
        assert.equal(store.get('finished'), null);
        assert.equal(fs.readdirSync(directory).length, 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
