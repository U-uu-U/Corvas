const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { resolveModelParameterRules, validateModelParameterRequest, validateParameterRules,
    createParameterValidationError } = require('./model-parameter-rules.cjs');
const { buildYueqiFastRequestBody } = require('../electron-main/video-provider-adapters.js');

const model = () => ({ id: 'example', kind: 'video', match: { model: ['^sd2-fast$'] },
    options: { duration: { type: 'range', min: 1, max: 12, integer: true },
        resolutionTier: { type: 'enum', values: ['480p', '720p'] }, ratio: { type: 'enum', values: ['16:9', '9:16'] } },
    capabilities: { referenceImages: { supported: true, max: 9 }, referenceVideos: { supported: true, max: 3 },
        referenceAudios: { supported: false, max: 0 } },
    parameterRules: { version: 1, rules: [
        { when: { resolutionTier: '480p' }, options: { duration: { type: 'range', min: 1, max: 15, integer: true } } },
        { when: { resolutionTier: '720p' }, options: { duration: { type: 'range', min: 1, max: 20, integer: true } },
            capabilities: { referenceImages: { supported: true, max: 7 } } }
    ] }
});

test('conditional rules widen base restrictions and never mutate shared snapshots', () => {
    const entry = model();
    const before = JSON.stringify(entry);
    assert.equal(validateModelParameterRequest(entry, { resolutionTier: '720p', duration: 20 }).ok, true);
    assert.equal(validateModelParameterRequest(entry, { resolutionTier: '480p', duration: 15 }).ok, true);
    assert.equal(validateModelParameterRequest(entry, { resolutionTier: '480p', duration: 16 }).ok, false);
    const high = resolveModelParameterRules(entry, { resolutionTier: '720p' });
    high.entry.options.duration.max = 999;
    high.entry.capabilities.referenceImages.max = 999;
    assert.equal(JSON.stringify(entry), before);
    assert.equal(validateModelParameterRequest(entry, { resolutionTier: '720p' }, { image: 8 }).issues[0].code, 'REFERENCE_LIMIT');
    assert.equal(validateModelParameterRequest(entry, { resolutionTier: '480p' }, { image: 8 }).ok, true);
});

test('request adapter uses remote duration rules instead of the old hardcoded maximum', () => {
    const request = { endpoint: 'https://art.ravenhash.org/v1', model: 'sd2-fast', prompt: 'test',
        resolution: '720p', duration: 20, aspectRatio: '9:16', modelConfigEntry: model() };
    assert.equal(buildYueqiFastRequestBody(request).seconds, '20');
    assert.throws(() => buildYueqiFastRequestBody({ ...request, duration: 21 }), {
        code: 'LOCAL_MODEL_PARAMETER_INVALID', submissionState: 'not_submitted'
    });
    assert.throws(() => buildYueqiFastRequestBody({ ...request, modelConfigEntry: null }), {
        code: 'LOCAL_SD2_FAST_DURATION_OUT_OF_RANGE'
    });
});

test('unknown versions and executable or overlarge rules fail closed', () => {
    const entry = model();
    entry.parameterRules.version = 2;
    const result = validateModelParameterRequest(entry, { resolutionTier: '720p', duration: 5 });
    assert.equal(result.ok, false);
    assert.equal(createParameterValidationError(result.issues).code, 'LOCAL_MODEL_RULES_UNSUPPORTED');
    assert.equal(validateParameterRules({ version: 1, rules: [{ when: { javascript: 'true' }, options: {} }] }).length, 1);
    assert.equal(validateParameterRules({ version: 1, rules: Array(65).fill(model().parameterRules.rules[0]) }).length, 1);
    assert.equal(validateParameterRules({ version: 1, rules: [{ when: { duration: 5 }, options: {
        duration: { type: 'range', min: 1, max: 100000, step: 0.00001 }
    } }] }).length, 1);
});

test('ordered fixed and enum patches use exact matching without changing unrelated entries', () => {
    const entry = model();
    entry.parameterRules.rules.push({ when: { resolutionTier: '720p', ratio: '9:16' },
        options: { duration: { type: 'fixed', value: 6 } } });
    assert.equal(validateModelParameterRequest(entry, { resolutionTier: '720p', ratio: '9:16', duration: 6 }).ok, true);
    assert.equal(validateModelParameterRequest(entry, { resolutionTier: '720p', ratio: '16:9', duration: 20 }).ok, true);
    entry.parameterRules.rules.push({ when: { resolutionTier: '720p', ratio: '9:16' },
        options: { duration: { type: 'enum', values: [4, 8] } } });
    assert.equal(validateModelParameterRequest(entry, { resolutionTier: '720p', ratio: '9:16', duration: 6 }).ok, false);
    const unrelated = { options: { duration: { type: 'fixed', value: 30 } } };
    assert.equal(validateModelParameterRequest(unrelated, { resolutionTier: '720p', duration: 30 }).ok, true);
});

test('public validation errors use numeric metadata and never configuration messages or tokens', () => {
    const error = createParameterValidationError([{ code: 'VALUE_NOT_ALLOWED', field: 'resolutionTier',
        allowed: ['720p', 'provider-secret', 'sk-private', 'USD0.42'], message: 'secret endpoint and cost' }]);
    assert.match(error.message, /720p/);
    assert.doesNotMatch(error.message, /secret|sk-|USD|endpoint|cost/);
    assert.deepEqual(error.parameterIssues[0].allowed, ['720p']);
});

test('both public CONFIG schemas accept the data contract and reject arbitrary rule keys', () => {
    for (const file of ['schemas/model-config.schema.json', '../configserver/schema/model-config.schema.json']) {
        const schema = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
        const ajv = new Ajv({ strict: false, validateFormats: false });
        const validate = ajv.compile(schema);
        const config = { schemaVersion: 1, models: [model()] };
        assert.equal(validate(config), true, JSON.stringify(validate.errors));
        config.models[0].parameterRules.rules[0].script = 'return true';
        assert.equal(validate(config), false);
    }
});
