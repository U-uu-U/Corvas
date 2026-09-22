// One-time server catalog preparation. Client code must not import this migration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const RELAY_HOSTS = ['art.ravenhash.org', 'cart.ravenhash.org'];
const IMAGE_HOSTS = ['ai.ravenhash.org'];
const STARFRAME_HOSTS = [...RELAY_HOSTS, 'api.xzapi.vip'];
const SHANHAI_HOSTS = [...RELAY_HOSTS, 'shanhai.vnshu.cn'];
const CATALOG_MAPPINGS = new Map([
    ['ravenhash-image.gpt-image-2', { model: 'gpt-image-2', hosts: IMAGE_HOSTS }],
    ['ravenhash-image.gpt-image-2.5-sunburst', { model: 'gpt-image-2.5-sunburst', hosts: IMAGE_HOSTS }],
    ['midjourney.mj-imagine', { model: 'mj_imagine', hosts: IMAGE_HOSTS }],
    ['ravenhash-video.sd2.5-route1', { model: 'sd2.5-route1', hosts: RELAY_HOSTS }],
    ['ravenhash-video.sd2.5', { model: 'sd2.5', hosts: RELAY_HOSTS }],
    ['ravenhash-video.seedance-2.5-pro', { model: 'seedance-2.5-pro', hosts: RELAY_HOSTS }],
    ['ravenhash-video.seedance-v2.5', { model: 'seedance_v2.5', hosts: RELAY_HOSTS }],
    ['ravenhash-video.hm-seedance-933', { model: 'seedance_v2.0-933', hosts: RELAY_HOSTS }],
    ['ravenhash-video.hm-seedance-101010', { model: 'seedance_v2.5-101010', hosts: RELAY_HOSTS, enabled: false }],
    ['ravenhash-video.hm-seedance-301010', { model: 'seedance_v2.5-301010', hosts: RELAY_HOSTS, enabled: false }],
    ['minimax-video.minimax-h3-seconds', { model: 'minimax-h3', hosts: RELAY_HOSTS }],
    ['starframe.ch0107-sd-2.5-720p', { model: 'ch0107-sd-2.5-720p', hosts: STARFRAME_HOSTS }],
    ['starframe.ch1401-sd-2.5-720p', { model: 'ch1401-sd-2.5-720p', hosts: STARFRAME_HOSTS }],
    ['globalaiopc.sd-2.5-discount-v1', { model: 'sd_2.5_discount_v1', hosts: ['zcbservice.aizfw.cn'], enabled: false }],
    ...['qbdmeb', '1iq31f', 'bkb50q', 'c6ws7e'].map(suffix => [
        `shanhai-video.oc-model-${suffix}`,
        { model: `oc-model-${suffix}`, hosts: SHANHAI_HOSTS, enabled: false, hidden: true }
    ])
]);

function attachCatalog(entry, mapping) {
    const { model, hosts, enabled = true, hidden = false } = mapping;
    entry.catalog = { model, hosts: [...hosts], enabled };
    entry.match = { ...entry.match, model: [`^${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`] };
    if (hidden) entry.presentation = { ...entry.presentation, visible: false };
    return entry;
}

export function prepareRemoteCatalog(source) {
    if (!source || typeof source !== 'object' || !Array.isArray(source.models)) {
        throw new Error('Source CONFIG must contain a models array.');
    }
    const config = structuredClone(source);
    config.catalogMode = 'remote';
    config.source = 'prepared:remote-catalog-v1';
    for (const entry of config.models) {
        if (!entry || typeof entry !== 'object' || Object.hasOwn(entry, 'catalog')) continue;
        const mapping = CATALOG_MAPPINGS.get(entry.id);
        if (!mapping) continue;
        attachCatalog(entry, mapping);
        if (entry.id === 'minimax-video.minimax-h3-seconds') {
            entry.presentation = { ...entry.presentation, label: 'MiniMax H3', routeGroup: '' };
        }
    }

    const generic = config.models.find(entry => entry?.id === 'ravenhash-video.seedance-2.0');
    if (generic) {
        for (const [order, variant] of ['fast', 'mini', 'pro'].entries()) {
            const id = `ravenhash-video.seedance-2.0-${variant}`;
            if (config.models.some(entry => entry?.id === id)) continue;
            const model = `artsdance2-0-${variant}-intl-260701`;
            const label = `Seedance 2.0 ${variant[0].toUpperCase()}${variant.slice(1)}`;
            const entry = attachCatalog({ ...structuredClone(generic), id, label }, { model, hosts: RELAY_HOSTS });
            entry.presentation = {
                ...entry.presentation,
                label,
                routeLabel: label,
                routeModelLabel: model,
                routeGroup: 'seedance20-recommended',
                routeGroupLabel: 'Seedance 2.0 推荐渠道',
                routeGroupOrder: 100,
                routeOrder: order,
                routeGroupAlways: true
            };
            config.models.push(entry);
        }
    }
    return config;
}

function main(args) {
    const options = { source: path.join(ROOT, 'shared', 'model-config.default.json') };
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!['--source', '--output'].includes(flag) || !value || value.startsWith('--')) {
            throw new Error('Usage: node scripts/prepare-remote-catalog.mjs [--source file] --output file');
        }
        options[flag.slice(2)] = path.resolve(value);
    }
    if (!options.output) throw new Error('--output is required; the source CONFIG is never overwritten.');
    const protectedFiles = [options.source, path.join(ROOT, 'shared', 'model-config.default.json'),
        path.join(ROOT, 'shared', 'model-channels.source.csv')];
    if (protectedFiles.some(file => path.resolve(file).toLowerCase() === options.output.toLowerCase())) {
        throw new Error('Output must be a separate server publication file.');
    }
    const config = prepareRemoteCatalog(JSON.parse(fs.readFileSync(options.source, 'utf8')));
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, JSON.stringify(config, null, 4) + '\n');
    const catalogEntries = config.models.filter(entry => entry?.catalog);
    console.log(`Prepared remote CONFIG: ${options.output}`);
    console.log(`Models: ${config.models.length}; catalog: ${catalogEntries.length}; enabled: ${catalogEntries.filter(entry => entry.catalog.enabled !== false).length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
    try { main(process.argv.slice(2)); }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
