import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createConfigStore, isVersionFileName } from './lib/store.mjs';
import { createValidator } from './lib/validate.mjs';

const DEFAULT_SCHEMA = fileURLToPath(new URL('./schema/model-config.schema.json', import.meta.url));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS = ['video', 'image', 'text'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class CatalogControlError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function fail(code, message) {
    throw new CatalogControlError(code, message);
}

function channelOf(value = 'preview') {
    if (value !== 'preview' && value !== 'stable') fail('INVALID_REQUEST', 'channel must be preview or stable');
    return value;
}

function kindOf(value = 'video') {
    if (!KINDS.includes(value)) fail('INVALID_REQUEST', 'kind must be video, image, or text');
    return value;
}

function targetOf(value) {
    if (!isObject(value)) fail('INVALID_REQUEST', 'target is required');
    const keys = Object.keys(value);
    if (keys.length !== 1 || !['id', 'model', 'group'].includes(keys[0])) {
        fail('INVALID_REQUEST', 'target must contain exactly one of id, model, group');
    }
    if (typeof value[keys[0]] !== 'string' || !value[keys[0]].trim()) {
        fail('INVALID_REQUEST', 'target must be a non-empty string');
    }
    return { [keys[0]]: value[keys[0]] };
}

function currentOf(store, channel) {
    const current = store.current(channel);
    if (!current || !Array.isArray(current.config?.models)) fail('NO_CONFIG', 'No valid configuration is active on this channel');
    return current;
}

function summarize(entry) {
    return {
        id: entry.id,
        model: entry.catalog?.model || '',
        label: entry.presentation?.label || entry.label || entry.catalog?.model || entry.id,
        group: entry.presentation?.routeGroup || '',
        enabled: isObject(entry.catalog) && entry.catalog.enabled !== false,
        visible: entry.presentation?.visible !== false
    };
}

function response(current, channel, extra = {}) {
    return { success: true, channel, revision: current.config.revision, version: current.name, ...extra };
}

function selectEntries(config, target, kind) {
    const entries = config.models.filter(entry => own(target, 'id') ? entry.id === target.id
        : own(target, 'model') ? entry.catalog?.model === target.model
            : entry.kind === kind && isObject(entry.catalog) && entry.presentation?.routeGroup === target.group);
    if (!entries.length) fail('NOT_FOUND', 'No catalog entries match this target');
    if (!own(target, 'group') && entries.length !== 1) fail('AMBIGUOUS_TARGET', 'Target matches multiple entries; use the exact entry id');
    return entries;
}

function enabledField(entry) {
    return own(entry.catalog, 'enabled')
        ? { present: true, value: entry.catalog.enabled }
        : { present: false };
}

function sameField(a, b) {
    return a.present === b.present && (!a.present || a.value === b.value);
}

function assignField(entry, field) {
    if (field.present) entry.catalog.enabled = field.value;
    else delete entry.catalog.enabled;
}

function receiptPath(dataDir, receiptId) {
    if (typeof receiptId !== 'string' || !UUID_PATTERN.test(receiptId)) fail('INVALID_RECEIPT', 'receiptId must be a lowercase UUID v4');
    return path.join(dataDir, 'operations', `${receiptId}.json`);
}

function writeReceipt(dataDir, receipt) {
    const target = receiptPath(dataDir, receipt.receiptId);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, target);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function readReceipt(dataDir, receiptId) {
    const file = receiptPath(dataDir, receiptId);
    if (!fs.existsSync(file)) fail('RECEIPT_NOT_FOUND', 'Operation receipt was not found');
    let receipt;
    try {
        receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        fail('INVALID_RECEIPT', 'Operation receipt is not valid JSON');
    }
    const validField = field => isObject(field) && typeof field.present === 'boolean'
        && (!field.present || typeof field.value === 'boolean');
    if (!isObject(receipt) || receipt.receiptId !== receiptId
        || !['preview', 'stable'].includes(receipt.channel)
        || !isVersionFileName(receipt.beforeVersion)
        || !['prepared', 'applied', 'restored'].includes(receipt.status)
        || !Array.isArray(receipt.changes) || !receipt.changes.length
        || receipt.changes.some(change => !isObject(change) || typeof change.id !== 'string'
            || !change.id || !validField(change.before) || !validField(change.after))
        || new Set(receipt.changes.map(change => change.id)).size !== receipt.changes.length) {
        fail('INVALID_RECEIPT', 'Operation receipt has an invalid structure');
    }
    return receipt;
}

function validateConfig(validator, config) {
    const result = validator.validate(config);
    if (!result.ok) fail('VALIDATION_FAILED', 'Configuration failed validation; no changes were published');
}

function assertUnchanged(store, channel, version) {
    if (currentOf(store, channel).name !== version) fail('CONFLICT', 'Configuration changed during this operation; read the current revision and retry');
}

export async function executeCatalogControl(request, {
    dataDir = '/var/lib/flow-config',
    schemaPath = DEFAULT_SCHEMA,
    store = createConfigStore({ dataDir }),
    validator: providedValidator
} = {}) {
    if (!isObject(request) || !['list', 'set', 'restore'].includes(request.action)) {
        fail('INVALID_REQUEST', 'action must be list, set, or restore');
    }
    if (request.action === 'restore') {
        const receipt = readReceipt(dataDir, request.receiptId);
        const channel = receipt.channel;
        const current = currentOf(store, channel);
        if (receipt.status === 'restored') return response(current, channel, { changed: 0, receiptId: receipt.receiptId, restored: true });
        if (receipt.status !== 'applied' || !isVersionFileName(receipt.afterVersion)) {
            fail('INCOMPLETE_OPERATION', 'This receipt was not marked applied; inspect the operation before restoring it');
        }
        const config = structuredClone(current.config);
        for (const change of receipt.changes) {
            const entries = config.models.filter(entry => entry.id === change.id);
            if (entries.length !== 1 || !isObject(entries[0].catalog)
                || !sameField(enabledField(entries[0]), change.after)) {
                fail('CONFLICT', 'A target entry changed after this operation; restore was not applied');
            }
            assignField(entries[0], change.before);
        }
        const validator = providedValidator || await createValidator({ schemaPath });
        validateConfig(validator, config);
        assertUnchanged(store, channel, current.name);
        const saved = store.save(config, {
            channel, actor: 'catalog-control', note: `restore ${receipt.receiptId}`
        });
        writeReceipt(dataDir, {
            ...receipt, status: 'restored', restoredVersion: saved.name,
            restoredAt: new Date().toISOString()
        });
        return response(saved, channel, { changed: receipt.changes.length, receiptId: receipt.receiptId, restored: true });
    }

    const channel = channelOf(request.channel);
    const current = currentOf(store, channel);
    if (request.action === 'list') {
        if (request.query !== undefined && typeof request.query !== 'string') fail('INVALID_REQUEST', 'query must be a string');
        const kind = request.kind === undefined ? null : kindOf(request.kind);
        const query = (request.query || '').toLocaleLowerCase();
        const models = current.config.models.filter(entry => !kind || entry.kind === kind)
            .map(summarize).filter(entry => !query || [entry.id, entry.model, entry.label, entry.group]
                .some(value => value.toLocaleLowerCase().includes(query)));
        return response(current, channel, { models });
    }

    const target = targetOf(request.target);
    const kind = kindOf(request.kind);
    if (typeof request.enabled !== 'boolean') fail('INVALID_REQUEST', 'enabled must be a boolean');
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
        fail('INVALID_REQUEST', 'expectedRevision must be a non-negative integer');
    }
    if (current.config.revision !== request.expectedRevision) fail('CONFLICT', 'expectedRevision does not match the active revision');
    const config = structuredClone(current.config);
    const selected = selectEntries(config, target, kind);
    const changes = [];
    for (const entry of selected) {
        if (!isObject(entry.catalog)) {
            if (request.enabled) fail('MISSING_CATALOG', 'Cannot enable an entry without catalog settings');
            continue;
        }
        if ((entry.catalog.enabled !== false) === request.enabled) continue;
        const change = { id: entry.id, before: enabledField(entry), after: { present: true, value: request.enabled } };
        assignField(entry, change.after);
        changes.push(change);
    }
    if (!changes.length) return response(current, channel, { changed: 0, receiptId: null, models: selected.map(summarize) });
    const validator = providedValidator || await createValidator({ schemaPath });
    validateConfig(validator, config);
    const receipt = {
        receiptId: randomUUID(), status: 'prepared', createdAt: new Date().toISOString(),
        channel, target, ...(own(target, 'group') ? { kind } : {}),
        beforeVersion: current.name, afterVersion: null, changes
    };
    writeReceipt(dataDir, receipt);
    assertUnchanged(store, channel, current.name);
    const saved = store.save(config, {
        channel, actor: 'catalog-control', note: `set ${receipt.receiptId}`
    });
    writeReceipt(dataDir, { ...receipt, status: 'applied', afterVersion: saved.name, appliedAt: new Date().toISOString() });
    return response(saved, channel, { changed: changes.length, receiptId: receipt.receiptId, models: selected.map(summarize) });
}

export async function runCatalogControlCli(args = process.argv.slice(2)) {
    try {
        const options = {};
        for (let index = 0; index < args.length; index += 2) {
            const name = args[index];
            if (!['--data-dir', '--schema-path'].includes(name) || !args[index + 1]) {
                fail('INVALID_ARGUMENT', 'Supported arguments: --data-dir PATH --schema-path PATH');
            }
            options[name === '--data-dir' ? 'dataDir' : 'schemaPath'] = args[index + 1];
        }
        const input = fs.readFileSync(0, 'utf8');
        if (Buffer.byteLength(input) > 65536) fail('INVALID_REQUEST', 'Request exceeds 64 KiB');
        let request;
        try {
            request = JSON.parse(input);
        } catch {
            fail('INVALID_REQUEST', 'stdin must contain one JSON object');
        }
        const result = await executeCatalogControl(request, options);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
    } catch (error) {
        const expected = error instanceof CatalogControlError;
        process.stdout.write(`${JSON.stringify({
            success: false, error: expected ? error.message : 'Catalog operation failed',
            code: expected ? error.code : 'OPERATION_FAILED'
        })}\n`);
        return 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await runCatalogControlCli();
}
