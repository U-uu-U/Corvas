import assert from 'node:assert/strict';

export const model = 'dola2.5特价';
export const id = 'ravenhash-video.dola25-discount';
export const label = 'Dola 2.5（特价）';
export const hosts = ['art.ravenhash.org', 'cart.ravenhash.org'];

export function addCatalogModel(current) {
    const config = globalThis.structuredClone(current);
    assert.ok(!config.models.some(entry => entry.id === id || entry.catalog?.model === model), 'Model already exists');
    const peerGroup = config.models.find(entry => entry.id === 'ravenhash-video.ft25-image30')?.presentation?.routeGroup;
    const group = config.catalogGroups.find(entry => entry.id === (peerGroup || 'seedance25-backup'))
        || config.catalogGroups.find(entry => entry.id === 'zhubo-video');
    assert.ok(group, 'Seedance 2.5 group missing');
    const routeOrder = Math.max(0, ...config.models.filter(entry => entry.presentation?.routeGroup === group.id)
        .map(entry => entry.presentation.routeOrder || 0)) + 1;
    config.models.push({ id, kind: 'video', label, route: label, channel: 'RavenHash视频', priority: 130,
        match: { model: ['^dola2\\.5特价$'] }, catalog: { model, hosts, enabled: true },
        presentation: { label, routeLabel: label, routeModelLabel: model, routeGroup: group.id,
            routeGroupLabel: group.label, routeGroupOrder: group.order, routeOrder, routeGroupAlways: true,
            routeGroupScope: 'catalog', visible: true },
        parameters: { accepts: ['model', 'prompt', 'seconds', 'duration', 'size', 'aspect_ratio', 'ratio', 'images', 'image_urls'],
            required: ['model', 'prompt'] },
        options: { duration: { type: 'range', min: 4, max: 30, integer: true, default: 4, unit: 'second', field: 'seconds' },
            ratio: { type: 'enum', values: ['16:9', '9:16', '1:1'], default: '16:9', field: 'size' },
            resolutionTier: { type: 'unsupported', reason: '接口未声明分辨率选择' } },
        capabilities: { referenceImages: { supported: true, max: 10 }, referenceVideos: { supported: false, max: 0 },
            referenceAudios: { supported: false, max: 0 }, webSearch: { supported: false }, cameraFixed: { supported: false },
            generatedAudio: { supported: false }, watermark: { supported: false } },
        parameterRules: { version: 1, rules: [] }, prompt: { required: true, maxLength: 5000 }, limits: { concurrency: 1 },
        notes: '4-30秒整数；最多10张参考图；按次计费；接口未声明输出分辨率' });
    assert.deepEqual(config.models.slice(0, -1), current.models);
    return config;
}
