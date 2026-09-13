import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { splitModelConfigDocumentation, renderModelConfigNotes } from '../scripts/model-config-documentation.mjs';
import { toVideoProfileOverrides, toImageProfileOverrides, validateModelRequest } from '../src/model-config-capabilities.js';

const require = createRequire(import.meta.url);
const { validateModelConfig } = require('../electron-main/model-config-service.cjs');
const source = JSON.parse(fs.readFileSync(new URL('./model-config.default.json', import.meta.url), 'utf8'));

test('export separates documentation losslessly without modifying the source or parameter values', () => {
    const before = structuredClone(source);
    const { config, annotations } = splitModelConfigDocumentation(source);
    assert.deepEqual(source, before);
    assert.equal(config.models.length, source.models.length);
    assert.equal(validateModelConfig(config).ok, true);
    assert.ok(annotations.length > 0);
    assert.doesNotMatch(JSON.stringify(config), /"(?:reason|note|notes|description|passRate|passRateNote|resultsPerRequestNote)"\s*:/);
    assert.deepEqual(splitModelConfigDocumentation(config), { config, annotations: [] });
    const restored = structuredClone(config);
    for (const item of annotations) {
        const parent = item.path.slice(0, -1).reduce((object, key) => object[key], restored);
        assert.equal(Object.hasOwn(parent, item.path.at(-1)), false);
        parent[item.path.at(-1)] = item.value;
    }
    assert.deepEqual(restored, source);
});

test('clean configuration produces the same image and video parameter profiles', () => {
    const { config } = splitModelConfigDocumentation(source);
    for (const [index, entry] of source.models.entries()) {
        const clean = config.models[index];
        assert.deepEqual(toImageProfileOverrides(config, clean), toImageProfileOverrides(source, entry));
        assert.deepEqual(toVideoProfileOverrides(config, clean), toVideoProfileOverrides(source, entry));
    }
});

test('unknown and unsupported constraints remain distinct without explanatory fields', () => {
    const original = {
        schemaVersion: 1,
        models: [{ id: 'fixture', kind: 'video', match: { model: ['^fixture$'] },
            options: {
                duration: { type: 'unknown', reason: 'unverified duration' },
                resolutionTier: { type: 'unsupported', reason: 'not sent by this route' }
            },
            capabilities: { referenceVideos: { supported: false, reason: 'not supported' } }
        }]
    };
    const { config } = splitModelConfigDocumentation(original);
    assert.equal(validateModelConfig(config).ok, true);
    const unknown = validateModelRequest({ config, provider: { model: 'fixture', kind: 'video' }, fields: { duration: 17 } });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.warnings[0].code, 'PARAM_UNVERIFIED');
    const unsupported = validateModelRequest({ config, provider: { model: 'fixture', kind: 'video' }, fields: { resolutionTier: '1080p' } });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.errors[0].code, 'PARAM_UNSUPPORTED');
    const reference = validateModelRequest({ config, provider: { model: 'fixture', kind: 'video' }, references: { video: 1 } });
    assert.equal(reference.ok, false);
    assert.equal(reference.errors[0].code, 'FEATURE_UNSUPPORTED');
});

test('field names and enum/default values are not mistaken for documentation', () => {
    const original = { schemaVersion: 1,
        fields: { note: { label: 'note', param: 'note', note: 'vocabulary documentation' } },
        models: [{ id: 'literal', kind: 'text', match: { model: ['literal'] },
            options: { reason: { type: 'enum', values: [{ note: 'literal value' }], default: { reason: 'literal default' }, note: 'option documentation' } }
        }]
    };
    const { config, annotations } = splitModelConfigDocumentation(original);
    assert.deepEqual(config.fields.note, { label: 'note', param: 'note' });
    assert.deepEqual(config.models[0].options.reason.values, original.models[0].options.reason.values);
    assert.deepEqual(config.models[0].options.reason.default, original.models[0].options.reason.default);
    assert.equal(annotations.length, 2);
    const notes = renderModelConfigNotes({ config, annotations, exportedAt: 'fixture', configSha256: 'fixture' });
    assert.ok(notes.includes('vocabulary documentation'));
    assert.ok(notes.includes('option documentation'));
});
