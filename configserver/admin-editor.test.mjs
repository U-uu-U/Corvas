import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEditorConfig, readEditorValues, applyEditorValues } from './lib/admin-editor-model.mjs';
import { createValidator } from './lib/validate.mjs';
import { adminPage } from './lib/pages.mjs';

const source = fs.readFileSync(new URL('./seed/model-config.default.json', import.meta.url), 'utf8');
const models = parseEditorConfig(source).models;
const entry = models.find(entry => entry.id === 'ravenhash-video.sd2.5-route1');
const ranged = models.find(entry => entry.id === 'ravenhash-video.seedance-v2.5');
const image = models.find(entry => entry.id === 'ravenhash-image.gpt-image-2');
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

test('untouched generation parameters round-trip unchanged for every seeded model', () => {
    for (const model of parseEditorConfig(source).models) {
        assert.deepEqual(patch(model, {}), model, model.id);
    }
});

test('duration keeps its declared shape and only changes what was edited', () => {
    assert.deepEqual(readEditorValues(entry).durationMode, 'fixed');
    assert.deepEqual(patch(entry, { durationValue: '25' }).options.duration,
        { type: 'fixed', value: 25, unit: 'second', note: entry.options.duration.note });
    assert.deepEqual(patch(entry, { durationMode: 'range', durationMin: '4', durationMax: '30', durationDefault: '30' }).options.duration,
        { type: 'range', min: 4, max: 30, integer: true, unit: 'second', default: 30, note: entry.options.duration.note });
    // Editing duration must not disturb sibling options such as ratio or resolution.
    assert.deepEqual(patch(entry, { durationValue: '25' }).options.ratio, entry.options.ratio);
});

test('every seeded duration shape reads back into the form without reinterpretation', () => {
    const range = readEditorValues(ranged);
    assert.equal(range.durationMode, 'range');
    assert.equal(range.durationMin, '4');
    assert.equal(range.durationMax, '30');
    assert.equal(range.durationInteger, 'true');
    // An image entry has no duration constraint at all: the form must not fabricate one.
    assert.equal(readEditorValues(image).durationMode, 'none');
    assert.equal(readEditorValues(image).referenceImagesMax, '');
    assert.equal(readEditorValues(image).referenceImagesBytes, '50');
});

test('range durations reject inverted, fractional and out-of-band defaults', () => {
    const range = { durationMode: 'range', durationMin: '4', durationMax: '30' };
    for (const values of [{ ...range, durationMin: '30', durationMax: '4' }, { ...range, durationMax: '' },
        { ...range, durationMax: '4.5' }, { ...range, durationDefault: '31' }, { ...range, durationMin: '-1' },
        { ...range, durationMax: '99999' }, { durationMode: 'sneaky' }]) {
        assert.throws(() => patch(entry, values), undefined, JSON.stringify(values));
    }
    assert.equal(patch(entry, { ...range, durationMax: '4.5', durationInteger: 'false' }).options.duration.max, 4.5);
});

test('enum durations dedupe and sort, and constrain the default to the listed values', () => {
    // The note travels with the mode switch because its input stays visible and populated:
    // the operator reads the stale text on screen and clears it, rather than losing it silently.
    const enumerated = patch(entry, { durationMode: 'enum', durationValues: '10, 5;5  12', durationAllowAuto: 'true' });
    assert.deepEqual(enumerated.options.duration,
        { type: 'enum', values: [5, 10, 12], allowAuto: true, note: entry.options.duration.note });
    assert.equal(patch(entry, { durationMode: 'enum', durationValues: '5 10', durationNote: '' })
        .options.duration.note, undefined);
    assert.equal(patch(entry, { durationMode: 'enum', durationValues: '5 10', durationDefault: '10' }).options.duration.default, 10);
    assert.throws(() => patch(entry, { durationMode: 'enum', durationValues: '5 10', durationDefault: '12' }));
    assert.throws(() => patch(entry, { durationMode: 'enum', durationValues: ' ' }));
});

test('clearing a constraint removes only that key and prunes empty containers', () => {
    assert.equal(patch(entry, { durationMode: 'none' }).options.duration, undefined);
    assert.deepEqual(patch(entry, { durationMode: 'none' }).options.ratio, entry.options.ratio);
    assert.deepEqual(patch(entry, { durationMode: 'unsupported', durationNote: '该线路不接受时长' }).options.duration,
        { type: 'unsupported', reason: '该线路不接受时长' });
    const lone = { id: 'lone', kind: 'video', match: { model: ['^lone$'] }, options: { duration: { type: 'fixed', value: 5 } } };
    assert.equal(patch(lone, { durationMode: 'none' }).options, undefined);
});

test('reference limits convert megabytes, keep undisplayed keys and distinguish absent from unsupported', () => {
    assert.equal(readEditorValues(entry).referenceImagesMax, '9');
    const raised = patch(entry, { referenceImagesMax: '12' });
    assert.equal(raised.capabilities.referenceImages.max, 12);
    assert.equal(raised.capabilities.referenceImages.note, entry.capabilities.referenceImages.note);
    assert.deepEqual(raised.capabilities.referenceVideos, entry.capabilities.referenceVideos);
    assert.equal(patch(entry, { referenceImagesBytes: '50' }).capabilities.referenceImages.maxBytesPerImage, 52428800);
    assert.equal(patch(entry, { referenceImagesMax: '' }).capabilities.referenceImages.max, undefined);
    assert.equal(patch(entry, { referenceImagesMode: 'none' }).capabilities.referenceImages, undefined);
    assert.deepEqual(patch(entry, { referenceImagesMode: 'unsupported', referenceImagesNote: '仅文生视频' }).capabilities.referenceImages,
        { supported: false, reason: '仅文生视频' });
    const withMin = { id: 'm', kind: 'video', match: { model: ['^m$'] },
        capabilities: { referenceImages: { supported: true, min: 1, params: ['image_urls'], max: 4 } } };
    assert.deepEqual(patch(withMin, { referenceImagesMax: '6' }).capabilities.referenceImages,
        { supported: true, min: 1, params: ['image_urls'], max: 6 });
});

test('reference limits reject fractional, negative and oversized values', () => {
    for (const values of [{ referenceImagesMax: '2.5' }, { referenceImagesMax: '-1' }, { referenceImagesMax: '1001' },
        { referenceImagesBytes: '0' }, { referenceImagesBytes: '2048' }, { referenceImagesBytes: '1.5' },
        { referenceImagesMode: 'maybe' }, { referenceImagesNote: 'x'.repeat(201) }]) {
        assert.throws(() => patch(entry, values), undefined, JSON.stringify(values));
    }
});

// The form is only trustworthy if everything it can emit also survives the real publish gate.
test('every shape the form can emit passes the same ajv schema the publish route uses', async () => {
    const validator = await createValidator({ schemaPath: fileURLToPath(new URL('./schema/model-config.schema.json', import.meta.url)) });
    assert.equal(validator.mode, 'schema', validator.note);
    const shapes = [
        { durationMode: 'fixed', durationValue: '30', durationNote: '固定 30 秒' },
        { durationMode: 'range', durationMin: '4', durationMax: '30', durationDefault: '30' },
        { durationMode: 'range', durationMin: '0.5', durationMax: '4.5', durationInteger: 'false' },
        { durationMode: 'enum', durationValues: '5 10 12', durationAllowAuto: 'true', durationDefault: '10' },
        { durationMode: 'unsupported', durationNote: '该线路不接受时长' },
        { durationMode: 'unknown', durationNote: '边界以上游返回为准' },
        { durationMode: 'none' },
        { referenceImagesMode: 'supported', referenceImagesMax: '30', referenceImagesBytes: '50', referenceImagesNote: '最多 30 张' },
        { referenceImagesMode: 'supported', referenceImagesMax: '' },
        { referenceImagesMode: 'unsupported', referenceImagesNote: '仅文生视频' },
        { referenceImagesMode: 'none' },
        { referenceVideosMode: 'supported', referenceVideosMax: '0' },
        { referenceAudiosMode: 'unsupported' }
    ];
    for (const values of shapes) {
        const models = parseEditorConfig(source).models;
        models[models.findIndex(model => model.id === entry.id)] = patch(entry, values);
        const result = validator.validate({ schemaVersion: 1, revision: 1, models });
        assert.ok(result.ok, `${JSON.stringify(values)} → ${(result.errors || []).join('; ')}`);
    }
});

// A `data-field` the markup never renders becomes an undefined control, and the panel dies on the
// first keystroke. Pin the rendered inputs to the values the form model actually produces.
test('rendered inputs and the form model agree exactly, for every seeded model', async () => {
    const { modelEditorMarkup } = await import('./lib/admin-editor-view.mjs');
    const rendered = [...modelEditorMarkup().matchAll(/data-field="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(rendered).size, rendered.length, 'duplicate data-field in markup');
    for (const model of parseEditorConfig(source).models) {
        // `updatedAt` is a read-only output, not an input, so it has no control by design.
        const expected = Object.keys(readEditorValues(model)).filter(key => key !== 'updatedAt');
        assert.deepEqual([...rendered].sort(), [...expected].sort(), model.id);
    }
});

test('the browser controller only indexes controls the markup renders', async () => {
    const { modelEditorMarkup } = await import('./lib/admin-editor-view.mjs');
    const { REFERENCE_KINDS } = await import('./lib/admin-editor-model.mjs');
    const rendered = new Set([...modelEditorMarkup().matchAll(/data-field="([^"]+)"/g)].map(match => match[1]));
    const controller = fs.readFileSync(new URL('./lib/admin-editor.mjs', import.meta.url), 'utf8');
    const referenced = new Set();
    for (const match of controller.matchAll(/controls(?:\.([A-Za-z_$][\w$]*)|\[\s*'([^']+)'\s*\])/g)) {
        referenced.add(match[1] || match[2]);
    }
    assert.ok(referenced.size, 'controller control lookup was not detected — regex needs updating');
    for (const key of referenced) assert.ok(rendered.has(key), `controls.${key} has no rendered input`);
    // Template-literal lookups resolve against the reference vocabulary rendered into the markup.
    for (const kind of REFERENCE_KINDS) {
        const suffixes = kind.bytes ? ['Mode', 'Max', 'Bytes', 'Note'] : ['Mode', 'Max', 'Note'];
        for (const suffix of suffixes) {
            assert.ok(rendered.has(`${kind.key}${suffix}`), `${kind.key}${suffix} missing from markup`);
        }
    }
});

test('a constraint type the form cannot edit is preserved rather than read as "unset"', async () => {
    const { DURATION_PRESERVED } = await import('./lib/admin-editor-model.mjs');
    const { modelEditorMarkup } = await import('./lib/admin-editor-view.mjs');
    // 选项值必须来自同一个常量，否则「保持原样」这个安全态会静默失效。
    assert.ok(modelEditorMarkup().includes(`<option value="${DURATION_PRESERVED}">`));
    // tier 是 schema 允许的类型。表单不编辑它，但绝不能显示成「不声明」再把它删掉。
    const tiered = { ...structuredClone(entry), options: { ...entry.options,
        duration: { type: 'tier', values: ['short', 'long'], default: 'short', encode: 'tier', field: 'seconds' } } };
    assert.equal(readEditorValues(tiered).durationMode, DURATION_PRESERVED);
    const kept = patch(tiered, { durationNote: '' });
    assert.deepEqual(kept.options.duration, tiered.options.duration);
    assert.notEqual(kept.options.duration, tiered.options.duration, '必须是拷贝而不是同一引用');
    // 运营主动改选真实类型时才替换；field 是类型无关的作用域声明，跨类型切换也要保留。
    assert.deepEqual(patch(tiered, { durationMode: 'range', durationMin: '1', durationMax: '5' }).options.duration,
        { type: 'range', min: 1, max: 5, integer: true, unit: 'second', field: 'seconds' });
    // 明确清空是允许的：那是运营的显式决定。
    assert.equal(patch(tiered, { durationMode: 'none' }).options.duration, undefined);
});

test('undisplayed declared keys survive an edit of the same constraint type', () => {
    const labelled = { ...structuredClone(entry), options: { ...entry.options,
        duration: { type: 'enum', values: [5, 10], labels: { 5: '短', 10: '长' }, default: 5, field: 'seconds' } } };
    assert.deepEqual(patch(labelled, { durationValues: '5, 10, 15' }).options.duration,
        { type: 'enum', values: [5, 10, 15], allowAuto: false, labels: { 5: '短', 10: '长' }, field: 'seconds', default: 5 });
    const stepped = { ...structuredClone(entry), options: { ...entry.options,
        duration: { type: 'range', min: 4, max: 30, integer: true, unit: 'second', step: 2 } } };
    assert.equal(patch(stepped, { durationMax: '20' }).options.duration.step, 2);
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
