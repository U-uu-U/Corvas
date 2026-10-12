import assert from 'node:assert/strict';
import fs from 'node:fs';
import { URL } from 'node:url';

export const spec = JSON.parse(fs.readFileSync(new URL('./model.json', import.meta.url), 'utf8'));
export const hosts = ['art.ravenhash.org', 'cart.ravenhash.org'];

export function addCatalogModel(current) {
    const config = globalThis.structuredClone(current);
    assert.ok(!config.models.some(entry => entry.id === spec.id || entry.catalog?.model === spec.model), 'Model already exists');
    const group = config.catalogGroups?.find(entry => entry.id === spec.group);
    assert.ok(group, 'Seedance 2.5 group missing');
    const routeOrder = Math.max(0, ...config.models.filter(entry => entry.presentation?.routeGroup === spec.group)
        .map(entry => entry.presentation.routeOrder || 0)) + 1;
    config.models.push({ id: spec.id, kind: 'video', label: spec.label, route: spec.label, channel: 'RavenHash视频', priority: 130,
        match: { model: ['^jijiu-video-301010-route3$'] }, catalog: { model: spec.model, hosts, enabled: true },
        presentation: { label: spec.label, routeLabel: spec.label, routeModelLabel: spec.model,
            routeGroup: spec.group, routeGroupLabel: group.label, routeGroupOrder: group.order, routeOrder,
            routeGroupAlways: true, routeGroupScope: 'catalog', visible: true },
        parameters: { accepts: ['model', 'prompt', 'duration', 'seconds', 'resolution', 'ratio', 'images', 'videos', 'audio_urls'],
            required: ['model', 'prompt'] },
        options: {
            duration: { type: 'range', min: spec.minSeconds, max: spec.maxSeconds, integer: true, default: 5, unit: 'second', field: 'duration' },
            ratio: { type: 'enum', values: spec.ratios, default: '16:9', field: 'ratio' },
            resolutionTier: { type: 'fixed', value: spec.resolution, field: 'resolution' }
        },
        capabilities: { referenceImages: { supported: true, max: spec.images }, referenceVideos: { supported: true, max: spec.videos },
            referenceAudios: { supported: true, max: spec.audios }, face: { supported: false }, webSearch: { supported: false },
            cameraFixed: { supported: false }, generatedAudio: { supported: false }, watermark: { supported: false } },
        parameterRules: { version: 1, rules: [] }, prompt: { required: true }, limits: { concurrency: 1 },
        notes: '720p；4-30秒整数；30图/10视频/10音频参考；11元/次' });
    assert.deepEqual(config.models.slice(0, -1), current.models);
    return config;
}
