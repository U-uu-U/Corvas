import assert from 'node:assert/strict';

export const model = 'yh-video-v25-cheap';
export const id = 'ravenhash-video.yh25-cheap';
export const hosts = ['art.ravenhash.org', 'cart.ravenhash.org'];

export function addCatalogModel(current) {
    const config = globalThis.structuredClone(current);
    assert.ok(!config.models.some(entry => entry.id === id || entry.catalog?.model === model), 'Model already exists');
    const peer = config.models.find(entry => entry.catalog?.model === 'seedance-2.5-super');
    const group = config.catalogGroups?.find(entry => entry.id === peer?.presentation?.routeGroup);
    assert.ok(group, 'Existing Seedance 2.5 group missing');
    const label = 'Seedance 2.5 Cheap';
    const routeOrder = Math.max(0, ...config.models.filter(entry => entry.presentation?.routeGroup === group.id)
        .map(entry => entry.presentation.routeOrder || 0)) + 1;
    config.models.push({ id, kind: 'video', label, route: label, channel: 'RavenHash视频', priority: 130,
        match: { model: ['^yh-video-v25-cheap$'] }, catalog: { model, hosts, enabled: true },
        presentation: { label, routeLabel: label, routeModelLabel: model, routeGroup: group.id,
            routeGroupLabel: group.label, routeGroupOrder: group.order, routeOrder,
            routeGroupAlways: true, routeGroupScope: 'catalog', visible: true },
        parameters: { accepts: ['model', 'prompt', 'duration', 'seconds', 'resolution', 'ratio', 'images', 'image_urls'],
            required: ['model', 'prompt'] },
        options: {
            duration: { type: 'range', min: 4, max: 30, integer: true, default: 15, unit: 'second', field: 'duration' },
            ratio: { type: 'enum', values: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], default: '16:9', field: 'ratio' },
            resolutionTier: { type: 'fixed', value: '720p', field: 'resolution' }
        },
        capabilities: { referenceImages: { supported: true, max: 30 }, referenceVideos: { supported: false },
            referenceAudios: { supported: false }, face: { supported: false }, webSearch: { supported: false },
            cameraFixed: { supported: false }, generatedAudio: { supported: false }, watermark: { supported: false } },
        parameterRules: { version: 1, rules: [] }, prompt: { required: true }, limits: { concurrency: 1 },
        notes: '720p；4-30秒；最多30张图片参考；4元/次；不支持视频参考，音频参考未获文档确认；真人照片可能不通过审核' });
    assert.deepEqual(config.models.slice(0, -1), current.models);
    return config;
}
