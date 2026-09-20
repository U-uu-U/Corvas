import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSidebar } from './agent-sidebar.js';

function harness(t, save) {
    const keys = ['flow-canvas-agent-providers', 'flow-canvas-agent-global', 'flow-canvas-api-config-meta-v1'];
    const data = new Map([[keys[0], JSON.stringify([{ id: 'old', apiKey: 'legacy-key' }])], [keys[1], '{}'], [keys[2], '{"revision":1}']]);
    const previous = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { flowCanvas: { apiConfig: { load: async () => ({ success: true, config: null }), save } } };
    globalThis.document = { dispatchEvent() {}, getElementById: () => null };
    globalThis.localStorage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
    const sidebar = Object.assign(Object.create(AgentSidebar.prototype), {
        providers: [{ id: 'old', apiKey: 'legacy-key' }], globalConfig: {}, apiConfigRevision: 1, localApiConfigPresent: true,
        _ensureProviderRoles() {}, _applyLoadedGlobalConfig() {}, _renderProviderList() {}, _renderAgentComposerModels() {},
        _renderAgentSkillList() {}, _renderAgentExecutionMode() {}
    });
    return { sidebar, data, keys };
}

test('desktop edits never write new credentials into localStorage', t => {
    const { sidebar, data } = harness(t, async () => ({ success: false }));
    sidebar.providers = [{ id: 'new', apiKey: 'new-secret' }];
    sidebar._writeLocalApiConfig();
    assert.equal([...data.values()].some(value => value.includes('new-secret')), false);
    assert.equal([...data.values()].some(value => value.includes('legacy-key')), true, 'Keep legacy credentials until encrypted migration succeeds');
});

test('successful encrypted migration removes the legacy cache only after the save', async t => {
    let submitted;
    const { sidebar, data, keys } = harness(t, async snapshot => { submitted = snapshot; return { success: true }; });
    const result = await sidebar._restoreDurableApiConfig();
    assert.equal(result.success, true); assert.equal(submitted.providers[0].apiKey, 'legacy-key');
    assert.ok(keys.every(key => !data.has(key)));
    assert.equal(sidebar.providers[0].apiKey, 'legacy-key', 'Credentials remain available in memory');
});

test('failed encrypted migration preserves the legacy cache for recovery', async t => {
    const { sidebar, data, keys } = harness(t, async () => ({ success: false, error: 'Encryption unavailable' }));
    const result = await sidebar._restoreDurableApiConfig();
    assert.equal(result.success, false);
    assert.ok(keys.every(key => data.has(key)));
    assert.equal(sidebar.providers[0].apiKey, 'legacy-key');
});
