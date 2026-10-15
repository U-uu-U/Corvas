import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteLogin } from './site-login.js';

function harness(t, providers = [], relayState = { onboardingSkipped: true }) {
    const previous = { window: globalThis.window, document: globalThis.document };
    t.after(() => Object.assign(globalThis, previous));
    function element() {
        const nodes = new Map(), listeners = new Map();
        return { dataset: {}, open: false, showCount: 0, textContent: '',
            setAttribute() {}, append() {},
            querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
            querySelectorAll() { return []; },
            addEventListener(type, fn) { listeners.set(type, fn); },
            fire(type, event = {}) { return listeners.get(type)?.(event); },
            showModal() { this.open = true; this.showCount++; }, close() { this.open = false; }
        };
    }
    const root = element(), status = element(), dialog = element();
    const state = { providers, manual: 0, skips: 0, reads: 0, relay: relayState, onState: null };
    globalThis.document = { getElementById: id => id === 'agentStationAccounts' ? root : status,
        createElement: () => dialog, body: { append() {} } };
    globalThis.window = { flowCanvas: { relay: {
        status: async () => { state.reads++; return state.relay; },
        onState: fn => { state.onState = fn; }, open: async () => {},
        skipOnboarding: () => { state.skips++; }
    } } };
    const login = createSiteLogin({ getProviders: () => state.providers, onManualSetup: () => { state.manual++; } });
    return { login, state, dialog };
}

test('empty API configuration prompts despite an old skip flag or an existing website login', async t => {
    const { login, state, dialog } = harness(t, [], { onboardingSkipped: true, accounts: { ai: { state: 'connected' } } });
    await login.start();
    assert.equal(dialog.open, true);
    dialog.querySelector('[data-login-skip]').fire('click');
    assert.equal(dialog.open, false);
    assert.equal(state.skips, 0, 'Dismissal must not create a persistent skip flag');
    await login.start();
    assert.equal(dialog.open, true);
});

test('failed configuration restore is never treated as an empty new account', async t => {
    const { login, state, dialog } = harness(t);
    await login.start({ configReady: false });
    assert.equal(dialog.open, false);
    assert.equal(state.reads, 0);
});

test('any restored API list suppresses startup setup and manual save closes an open prompt', async t => {
    const { login, state, dialog } = harness(t, [{ id: 'custom', apiKey: 'fixture' }]);
    await login.start();
    assert.equal(dialog.open, false);
    state.providers = [];
    await login.start();
    assert.equal(dialog.open, true);
    state.providers = [{ id: 'manual', apiKey: 'fixture' }];
    login.render();
    assert.equal(dialog.open, false);
});

test('manual setup stays available when station status cannot be read', async t => {
    const { login, state, dialog } = harness(t);
    globalThis.window.flowCanvas.relay.status = async () => { throw new Error('offline'); };
    await login.start();
    assert.equal(dialog.open, true);
    dialog.querySelector('[data-login-manual]').fire('click');
    assert.equal(state.manual, 1);
    assert.equal(dialog.open, false);
});
