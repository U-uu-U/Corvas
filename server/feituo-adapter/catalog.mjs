import assert from 'node:assert/strict';
import fs from 'node:fs';
import { URL } from 'node:url';

export const models = JSON.parse(fs.readFileSync(new URL('./models.json', import.meta.url), 'utf8'));
export const hosts = ['art.ravenhash.org', 'cart.ravenhash.org'];
export const saleCny = spec => Math.round(spec.costCny * 300) / 100;

export function addCatalogModels(current, selectedModels = models) {
    const config = globalThis.structuredClone(current);
    for (const spec of selectedModels) {
        assert.ok(!config.models.some(entry => entry.id === spec.id || entry.catalog?.model === spec.model), 'Model already exists');
        let group = config.catalogGroups?.find(entry => entry.id === spec.group);
        if (!group) {
            group = { id: spec.group, kind: 'video', label: spec.groupLabel, order: spec.groupOrder,
                scope: 'catalog', description: '' };
            (config.catalogGroups ||= []).push(group);
        }
        const routeOrder = 1 + Math.max(0, ...config.models.filter(entry => entry.presentation?.routeGroup === group.id)
            .map(entry => entry.presentation.routeOrder || 0));
        config.models.push({ id: spec.id, kind: 'video', label: spec.label, route: spec.label,
            channel: 'RavenHash视频', priority: 130, match: { model: [`^${spec.model}$`] },
            catalog: { model: spec.model, hosts, enabled: true },
            presentation: { label: spec.label, routeLabel: spec.label, routeModelLabel: spec.model,
                routeGroup: group.id, routeGroupLabel: group.label, routeGroupOrder: group.order,
                routeOrder, routeGroupAlways: true, routeGroupScope: 'catalog', visible: true },
            parameters: { accepts: ['model', 'prompt', 'duration', 'seconds', 'ratio', 'aspect_ratio', 'resolution',
                'images', 'image_urls', 'videos', 'video_urls', 'audio_urls'], required: ['model', 'prompt'] },
            options: {
                duration: spec.durations
                    ? { type: 'enum', values: spec.durations, default: spec.minSeconds, unit: 'second', field: 'duration' }
                    : spec.minSeconds === spec.maxSeconds
                    ? { type: 'fixed', value: spec.minSeconds, unit: 'second', field: 'duration' }
                    : { type: 'range', min: spec.minSeconds, max: spec.maxSeconds, integer: true,
                        default: spec.minSeconds, unit: 'second', field: 'duration' },
                ratio: { type: 'enum', values: spec.ratios, default: '16:9', field: 'ratio' },
                resolutionTier: { type: 'fixed', value: '720p', field: 'resolution' }
            },
            capabilities: { referenceImages: { supported: true, max: spec.images },
                referenceVideos: { supported: spec.videos > 0, max: spec.videos },
                referenceAudios: { supported: spec.audios > 0, max: spec.audios }, face: { supported: false },
                webSearch: { supported: false }, cameraFixed: { supported: false },
                generatedAudio: { supported: false }, watermark: { supported: false } },
            parameterRules: { version: 1, rules: [] },
            prompt: { required: true, ...(spec.promptMaxChars ? { maxLength: spec.promptMaxChars } : {}) },
            limits: { concurrency: 1 },
            notes: `720p；${spec.durations ? spec.durations.join('/') : spec.minSeconds === spec.maxSeconds ? `固定${spec.minSeconds}` : `${spec.minSeconds}-${spec.maxSeconds}`}秒；`
                + `${spec.images}图/${spec.videos}视频/${spec.audios}音频参考；按次计费`
        });
    }
    assert.deepEqual(config.models.slice(0, -selectedModels.length), current.models);
    return config;
}
