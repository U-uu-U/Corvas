import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSidebar } from './agent-sidebar.js';
import { modelConfigStore } from './model-config.js';

function element(tag = 'input', value = '') {
    const node = { tag, value, hidden: false, disabled: false, textContent: '', children: [], style: {},
        classList: { add() {}, remove() {} }, appendChild(child) { this.children.push(child); },
        append(...children) { this.children.push(...children); }, setAttribute() {}, addEventListener() {}, focus() {},
        querySelectorAll: () => [] };
    Object.defineProperties(node, {
        innerHTML: { get: () => '', set: () => { node.children = []; } },
        options: { get: () => node.children }
    });
    return node;
}

const entry = (model, kind = 'video', overrides = {}) => ({ id: model, kind,
    catalog: { model, hosts: ['art.ravenhash.org', 'cart.ravenhash.org'] }, ...overrides });
const catalog = (...models) => ({ catalogMode: 'remote',
    catalogScope: { hosts: ['art.ravenhash.org', 'cart.ravenhash.org'], kinds: ['video'] }, models });

function harness(t, config = catalog(entry('first'), entry('second'))) {
    const previousGlobals = new Map(['document', 'window', 'alert'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const previousMethods = { getConfig: modelConfigStore.getConfig, getStatus: modelConfigStore.getStatus };
    t.after(() => {
        for (const [key, descriptor] of previousGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
        Object.assign(modelConfigStore, previousMethods);
    });
    globalThis.document = { createElement: element, querySelectorAll: () => [], querySelector: () => null };
    const state = { config, saved: 0, fetches: 0, alerts: [] };
    globalThis.window = { flowCanvas: { ai: { fetchModels: async () => {
        state.fetches++;
        return { success: true, models: ['upstream-only'] };
    } } } };
    globalThis.alert = message => state.alerts.push(message);
    modelConfigStore.getConfig = () => state.config;
    modelConfigStore.getStatus = () => ({ origin: 'remote' });
    const sidebar = Object.assign(Object.create(AgentSidebar.prototype), {
        providers: [], globalConfig: {}, editingProviderId: null, formCatalogBinding: null,
        apiForm: element('form'), apiFormTitle: element(), addApiBtn: element('button'),
        formName: element(), formCapability: element('select', 'image'), formType: element('select', 'openai'),
        formEndpoint: element('input', 'https://art.ravenhash.org'), formKey: element('input', 'fixture-key'),
        formModel: element(), fetchedModelSelect: element('select'), fetchedModelOptions: element('datalist'),
        additionalModelsEl: element('div'), fetchModelsBtn: element('button'), addModelSlotBtn: element('button'),
        modelFetchStatus: element('span'), fetchedModels: [], modelFormRequestVersion: 0,
        _saveConfig() { state.saved++; }, _renderProviderList() {}, _renderAgentComposerModels() {}
    });
    return { sidebar, state };
}

for (const host of ['art.ravenhash.org', 'cart.ravenhash.org']) {
    test(`${host} selects video from CONFIG without fetching upstream models`, async t => {
        const config = catalog(entry('first'), entry('disabled', 'video', {
            catalog: { model: 'disabled', hosts: [host], enabled: false }
        }), entry('hidden', 'video', { presentation: { visible: false } }), entry('second'));
        const { sidebar, state } = harness(t, config);
        sidebar.formEndpoint.value = `https://${host}`;
        sidebar._syncFormCatalog({ autoCapability: true });
        assert.equal(sidebar.formCapability.value, 'video');
        assert.deepEqual(sidebar.fetchedModels, ['first', 'second']);
        assert.equal(sidebar.formModel.value, 'first');
        assert.equal(sidebar.fetchModelsBtn.hidden, true);
        assert.equal(sidebar.addModelSlotBtn.hidden, true);
        assert.equal(sidebar.formModel.hidden, true);
        assert.equal(sidebar.fetchedModelSelect.hidden, false);
        await sidebar._fetchModelsForForm();
        assert.equal(state.fetches, 0);

        sidebar._saveForm();
        assert.equal(state.saved, 1);
        assert.deepEqual(state.alerts, []);
        const saved = sidebar.providers[0];
        assert.deepEqual(saved.models, []);
        assert.equal(saved.modelCatalog, 'remote');
        assert.equal(saved.model, 'first');
        assert.equal(saved.name, host);
        assert.equal(saved.endpoint, `https://${host}/v1`);
        assert.equal(saved.apiKey, 'fixture-key');
        assert.equal(sidebar._getVideoProvider().model, 'first');
    });
}

test('new image accounts use exact remote entries outside the legacy video scope', t => {
    const config = catalog(entry('gpt-image-2', 'image', {
        catalog: { model: 'gpt-image-2', hosts: ['ai.ravenhash.org'] }
    }));
    const { sidebar, state } = harness(t, config);
    sidebar.formEndpoint.value = 'https://ai.ravenhash.org';
    sidebar._syncFormCatalog({ autoCapability: true });
    sidebar._saveForm();
    assert.equal(state.saved, 1);
    assert.equal(sidebar.providers[0].capability, 'image');
    assert.equal(sidebar.providers[0].modelCatalog, 'remote');
    assert.deepEqual(sidebar.providers[0].models, []);
    assert.equal(sidebar._getImageProvider().model, 'gpt-image-2');
});

test('editing a custom text API keeps manual models and the existing text role', t => {
    const { sidebar, state } = harness(t);
    const provider = { id: 'custom-text', name: 'Custom Text', endpoint: 'https://ai.ravenhash.org/v1',
        capability: 'text', type: 'openai', apiKey: 'old-key', model: 'custom-chat', models: ['custom-chat'] };
    sidebar.providers = [provider];
    sidebar.globalConfig.textProviderId = provider.id;
    sidebar._showForm(provider);
    assert.equal(sidebar._formCatalogState().managed, false);
    assert.equal(sidebar.formModel.hidden, false);
    assert.equal(sidebar.fetchModelsBtn.hidden, false);
    sidebar.formKey.value = 'replacement-key';
    sidebar._saveForm();
    assert.equal(state.saved, 1);
    assert.equal(sidebar.providers[0].modelCatalog, undefined);
    assert.deepEqual(sidebar.providers[0].models, ['custom-chat']);
    assert.equal(sidebar.providers[0].model, 'custom-chat');
    assert.equal(sidebar.globalConfig.textProviderId, provider.id);
});

test('editing a remote API key retains its selected default instead of the first catalog entry', t => {
    const { sidebar, state } = harness(t);
    const provider = { id: 'saved-video', name: 'Video', endpoint: 'https://art.ravenhash.org/v1',
        capability: 'video', type: 'openai', apiKey: 'old-key', model: 'second', models: [], modelCatalog: 'remote' };
    sidebar.providers = [provider];
    sidebar.globalConfig.videoProviderId = provider.id;
    sidebar._showForm(provider);
    assert.equal(sidebar.formModel.value, 'second');
    assert.equal(sidebar.fetchedModelSelect.value, 'second');
    sidebar.formKey.value = 'replacement-key';
    sidebar._syncFormCatalog();
    sidebar._saveForm();
    assert.equal(state.saved, 1);
    assert.equal(sidebar.providers[0].apiKey, 'replacement-key');
    assert.equal(sidebar.providers[0].model, 'second');
    assert.equal(sidebar._getVideoProvider().model, 'second');
});

test('an unavailable saved default is never replaced silently with the first remote model', t => {
    const { sidebar, state } = harness(t, catalog(entry('first'), entry('retired', 'video', {
        catalog: { model: 'retired', hosts: ['art.ravenhash.org'], enabled: false }
    })));
    const provider = { id: 'saved-video', name: 'Video', endpoint: 'https://art.ravenhash.org/v1',
        capability: 'video', type: 'openai', apiKey: 'old-key', model: 'retired', models: [], modelCatalog: 'remote' };
    sidebar.providers = [provider];
    sidebar.globalConfig.videoProviderId = provider.id;
    sidebar._showForm(provider);
    assert.equal(sidebar.formModel.value, 'retired');
    assert.equal(sidebar.fetchedModelSelect.options.find(option => option.value === 'retired').disabled, true);
    sidebar.formKey.value = 'replacement-key';
    sidebar._saveForm();
    assert.equal(state.saved, 0);
    assert.equal(sidebar.providers[0].model, 'retired');
    assert.equal(sidebar.globalConfig.videoProviderId, provider.id);
    assert.ok(sidebar.modelFetchStatus.textContent);
});

test('CONFIG refresh updates an open form without changing its saved model binding', t => {
    const { sidebar, state } = harness(t);
    const provider = { id: 'saved-video', name: 'Video', endpoint: 'https://art.ravenhash.org/v1',
        capability: 'video', type: 'openai', apiKey: 'fixture-key', model: 'second', models: [], modelCatalog: 'remote' };
    sidebar.providers = [provider];
    sidebar.globalConfig.videoProviderId = provider.id;
    sidebar._showForm(provider);
    state.config = catalog(entry('new-first'), entry('second'), entry('third'));
    sidebar._syncFormCatalog();
    assert.deepEqual(sidebar.fetchedModels, ['new-first', 'second', 'third']);
    assert.equal(sidebar.formModel.value, 'second');
    assert.equal(sidebar.fetchedModelSelect.value, 'second');
    assert.equal(sidebar._getVideoProvider().model, 'second');
    assert.equal(state.saved, 0);
    assert.equal(state.fetches, 0);

    state.config = catalog();
    sidebar._syncFormCatalog();
    assert.equal(sidebar._formCatalogState().managed, true);
    assert.deepEqual(sidebar.fetchedModels, []);
    assert.equal(sidebar.formModel.value, 'second');
    assert.equal(sidebar.fetchedModelSelect.disabled, true);
    assert.equal(sidebar.fetchModelsBtn.hidden, true);
    assert.equal(sidebar.providers[0].model, 'second');
});

test('saving a malformed URL in strict remote mode reports validation instead of throwing', t => {
    const { sidebar, state } = harness(t, { catalogMode: 'remote', models: [entry('first')] });
    for (const endpoint of ['', 'not-a-url', 'file:///tmp/models', 'https://user:pass@art.ravenhash.org/v1']) {
        sidebar.formEndpoint.value = endpoint;
        assert.doesNotThrow(() => sidebar._saveForm(), endpoint);
        assert.equal(state.saved, 0);
        assert.deepEqual(sidebar.providers, []);
        assert.ok(sidebar.modelFetchStatus.textContent);
    }
});

test('an explicit text template is not changed to image when CONFIG refreshes', t => {
    const { sidebar } = harness(t, catalog(entry('remote-image', 'image', {
        catalog: { model: 'remote-image', hosts: ['ai.ravenhash.org'] }
    })));
    sidebar.formCapabilityAuto = true;
    sidebar._applyTemplate('ravenhash-text');
    sidebar._syncFormCatalog({ autoCapability: sidebar.formCapabilityAuto === true });
    assert.equal(sidebar.formCapability.value, 'text');
    assert.equal(sidebar.formCapabilityAuto, false);
    assert.equal(sidebar.formModel.hidden, false);
    assert.equal(sidebar.fetchModelsBtn.hidden, false);
});
