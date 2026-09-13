import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseEditorConfig, readEditorValues, applyEditorValues } from './lib/admin-editor-model.mjs';
import { adminPage } from './lib/pages.mjs';

const source = fs.readFileSync(new URL('./seed/model-config.default.json', import.meta.url), 'utf8');
const entry = parseEditorConfig(source).models.find(entry => entry.id === 'ravenhash-video.sd2.5-route1');
const patch = (base, values, keys = Object.keys(values)) => applyEditorValues(base,
    { ...readEditorValues(base), ...values }, new Set(keys), '2026-09-14T00:00:00Z');

test('opening or editing display fields preserves all other fields and price provenance', () => {
    const base = { ...structuredClone(entry), futureOptions: { custom: ['keep'], note: 'keep' } };
    const before = structuredClone(base);
    assert.deepEqual(patch(base, {}), base);
    const changed = patch(base, { label: 'Remote name', description: 'Remote description' });
    assert.deepEqual(changed, { ...before, presentation: { ...before.presentation, label: 'Remote name', description: 'Remote description' } });
    assert.deepEqual(base, before);
});

test('editing prices preserves currency and unit, stamps changes only, and accepts an explicit zero', () => {
    const updated = patch(entry, { amount: '6.5' });
    assert.equal(updated.pricing.amount, 6.5);
    assert.equal(updated.pricing.currency, 'CNY');
    assert.equal(updated.pricing.unit, 'request');
    assert.equal(updated.pricing.kind, 'sale');
    assert.equal(updated.pricing.updatedAt, '2026-09-14T00:00:00Z');
    assert.equal(patch(entry, { amount: String(entry.pricing.amount) }).pricing.updatedAt, entry.pricing.updatedAt);
    assert.equal(patch(entry, { amount: '0', currency: 'USD', unit: 'second' }).pricing.amount, 0);
    assert.equal(patch(entry, { currency: 'USD' }).pricing.currency, 'USD');
});

test('inherit and unknown prices have different serialized meanings', () => {
    assert.equal(patch(entry, { priceMode: 'inherit' }).pricing, undefined);
    assert.deepEqual(patch(entry, { priceMode: 'unknown' }).pricing, { status: 'unknown', hosts: entry.pricing.hosts });
    assert.deepEqual(patch(entry, { hosts: 'ART.RAVENHASH.ORG, ai.ravenhash.org\nart.ravenhash.org' }).pricing.hosts,
        ['art.ravenhash.org', 'ai.ravenhash.org']);
});

test('invalid prices cannot be converted silently into a zero, cost, or unscoped sale', () => {
    for (const values of [{ amount: '' }, { amount: 'oops' }, { amount: '-1' }, { amount: 'Infinity' },
        { currency: 'RMB' }, { unit: 'token' }, { source: ' ' }, { hosts: '' },
        { hosts: 'https://art.ravenhash.org/v1' }, { hosts: '*.ravenhash.org' }]) {
        assert.throws(() => patch(entry, values), undefined, JSON.stringify(values));
    }
});

test('explicit clears do not create overrides for untouched inherited fields', () => {
    const bare = { id: 'new', kind: 'video', match: { model: ['^new$'] } };
    assert.deepEqual(patch(bare, { label: 'New label' }).presentation, { label: 'New label' });
    assert.equal(patch(entry, { label: '' }).presentation.label, undefined);
    assert.equal(patch(entry, { routeGroup: '' }).presentation.routeGroup, '');
    assert.equal(patch(entry, { recommended: 'inherit' }).presentation.recommended, undefined);
    assert.equal(patch(entry, { recommended: 'false' }).presentation.recommended, false);
});

test('bad JSON and duplicate IDs stay in the raw editor instead of dropping data', () => {
    assert.throws(() => parseEditorConfig('{bad'));
    assert.throws(() => parseEditorConfig(JSON.stringify({ schemaVersion: 1, models: [entry, entry] })));
    assert.throws(() => parseEditorConfig(JSON.stringify({ schemaVersion: 1, models: [] })));
});

test('admin forms use absolute routes and safely preserve rejected JSON, draft and note', () => {
    const malicious = '</textarea><script>window.injected=1</script>';
    const html = adminPage({ editorText: malicious, draft: true, note: '"><script>bad</script>', csrf: 'test-token' });
    assert.match(html, /action="\/admin\/save"/);
    assert.match(html, /action="\/admin\/logout"/);
    assert.match(html, /src="\/admin\/assets\/admin-editor\.mjs"/);
    assert.match(html, /name="draft" value="1" checked/);
    assert.ok(!html.includes(malicious));
    assert.ok(html.includes('&lt;/textarea&gt;'));
});
