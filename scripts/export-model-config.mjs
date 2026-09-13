// Export public built-in configuration, never account settings or runtime caches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { NODE_TYPES } from '../src/node-types.js';
import { IMAGE_RESOLUTION_TIERS, IMAGE_ASPECT_RATIOS, resolveImageDimensions } from '../src/image-node-settings.js';
import { VIDEO_MODEL_PROFILES, DEFAULT_VIDEO_MODEL_PROFILE, getVideoModelProfile } from '../shared/video-model-profiles.mjs';
import { splitModelConfigDocumentation, renderModelConfigNotes } from './model-config-documentation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { validateModelConfig } = require('../electron-main/model-config-service.cjs');
const configPath = 'shared/model-config.default.json';
const sourceConfig = JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8'));
const { config, annotations } = splitModelConfigDocumentation(sourceConfig);
const validation = validateModelConfig(config);
if (!validation.ok) throw new Error(`Invalid CONFIG: ${validation.errors.join('; ')}`);

const exportedAt = new Date().toISOString();
const stamp = exportedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const directory = path.join(root, 'output', `Flow-Canvas-model-config-${stamp}`);
fs.mkdirSync(path.dirname(directory), { recursive: true });
fs.mkdirSync(directory);
const files = [];
const sha256 = data => createHash('sha256').update(data).digest('hex');
function write(relative, data) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
    files.push({ path: relative, bytes: Buffer.byteLength(data), sha256: sha256(data) });
}
function copy(source, destination = source) {
    write(destination, fs.readFileSync(path.join(root, source)));
}
function json(relative, value) {
    write(relative, JSON.stringify(value, (_key, item) => item instanceof RegExp
        ? { source: item.source, flags: item.flags } : item, 2) + '\n');
}

json('CONFIG.json', config);
write('CONFIG-NOTES.md', renderModelConfigNotes({ config, annotations, exportedAt,
    configSha256: files.find(file => file.path === 'CONFIG.json').sha256 }));
copy('shared/schemas/model-config.schema.json', 'model-config.schema.json');

const includeReference = process.argv.includes('--with-reference');
if (includeReference) {
    copy('shared/model-channels.source.csv', 'model-channels.source.csv');
    copy('docs/model-config-export.md', 'README.md');
    copy('docs/model-config-handoff.md', 'HANDOFF.md');
    copy('docs/model-config.md', 'reference/model-config.md');
    copy('configserver/README.md', 'reference/configserver.md');

    const priceModels = ['sd2.5-route1', 'sd2.5-route2', 'sd2.5', 'sd2.5-haidiyue-face',
        'seedance_v2.5', 'seedance_v2.0-933', 'seedance_v2.5-101010', 'seedance_v2.5-301010'];
    const endpoint = 'https://art.ravenhash.org/v1';
    json('LOCAL-ONLY.json', {
        exportOnly: true,
        acceptedAsRemoteConfig: false,
        description: 'Reference snapshot of local defaults, not remotely applied settings. Prices are display sale prices, not billing rules or costs.',
        videoProfiles: VIDEO_MODEL_PROFILES,
        defaultVideoProfile: DEFAULT_VIDEO_MODEL_PROFILE,
        pricedRoutes: priceModels.map(model => {
            const profile = getVideoModelProfile({ model, endpoint });
            return { model, endpoint, routeLabel: profile?.routeLabel, routeGroup: profile?.routeGroup,
                routeModelLabel: profile?.routeModelLabel, price: profile?.price ?? null };
        }),
        nodeControls: Object.fromEntries(['text', 'image', 'video'].map(kind => [kind, NODE_TYPES[kind].config])),
        imageDimensions: IMAGE_RESOLUTION_TIERS.map(tier => ({ tier,
            ratios: IMAGE_ASPECT_RATIOS.filter(ratio => ratio !== 'adaptive')
                .map(ratio => ({ ratio, ...resolveImageDimensions(tier, ratio) })) })),
        adaptiveImageDimensions: 'Calculated from the first reference. See reference/src/image-node-settings.js.',
        concurrency: 'CONFIG limits.concurrency is descriptive. Actual scheduling uses node config.concurrency; MJ forces 1 inside each node batch.'
    });

    // Only these source files are included; no recursive scan of user data or secrets.
    for (const source of [
        'shared/video-model-profiles.mjs',
        'src/model-config.js', 'src/model-config-capabilities.js',
        'src/node-types.js', 'src/image-node-settings.js', 'src/generation-request-params.js',
        'src/provider-capabilities.js', 'src/agent-sidebar.js', 'src/canvas.js',
        'electron-main/agent-generation.mjs', 'electron-main/agent-provider.cjs',
        'electron-main/video-provider-adapters.js', 'electron-main/openai-image-request.js',
        'electron-main/mcp-bridge.js', 'electron-main/model-config-service.cjs'
    ]) copy(source, `reference/${source}`);
}

json('MANIFEST.json', {
    exportedAt,
    source: 'local-source-builtin',
    sourcePath: configPath,
    sourceRevision: config.revision,
    sourceUpdatedAt: config.updatedAt,
    documentationSeparated: true,
    separatedAnnotationCount: annotations.length,
    referenceIncluded: includeReference,
    liveRemoteConfigIncluded: false,
    runtimeCacheIncluded: false,
    apiCredentialsIncluded: false,
    modelCount: config.models.length,
    countsByKind: Object.fromEntries(['image', 'video', 'text']
        .map(kind => [kind, config.models.filter(model => model.kind === kind).length])),
    models: config.models.map(({ id, label, kind, route }) => ({ id, label, kind, route })),
    files
});
console.log(JSON.stringify({ directory, models: config.models.length, files: files.length }, null, 2));
