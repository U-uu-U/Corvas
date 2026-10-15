export const nanoBananaEntry = {
    id: 'ravenhash-image.nano-banana-2-1', kind: 'image', label: 'Nano Banana 2.1',
    channel: 'RavenHash图片', route: 'Nano Banana 2.1', priority: 120,
    match: { model: ['^gemini-nano-banana-2\\.1$'], endpoint: '^https://ai\\.ravenhash\\.org(?::443)?(?:/|$)' },
    catalog: { model: 'gemini-nano-banana-2.1', hosts: ['ai.ravenhash.org'], enabled: true },
    presentation: { label: 'Nano Banana 2.1', routeLabel: 'Nano Banana 2.1', visible: true },
    parameters: { accepts: ['model', 'prompt', 'size', 'resolutionTier', 'ratio', 'n', 'reference_images'], required: ['model', 'prompt'] },
    options: {
        resolutionTier: { type: 'tier', values: ['1K', '2K', '4K'], default: '1K', encode: 'tier', field: 'imageSize' },
        ratio: { type: 'enum', values: ['adaptive', '1:1', '9:16', '16:9', '3:4', '4:3', '2:3', '3:2', '4:5', '5:4', '21:9', '1:4', '4:1', '1:8', '8:1'],
            default: 'adaptive', allowAuto: true, field: 'aspectRatio' },
        n: { type: 'fixed', value: 1 }
    },
    capabilities: { referenceImages: { supported: true }, webSearch: { supported: false } },
    prompt: { required: true }, limits: { concurrency: 1 },
    notes: '文字与参考图生图；1K/2K/4K；自适应及多种画面比例。Gemini 原生接口需要包含 Nano Banana 适配的客户端。'
};

export function addNanoBanana(config, pricing = null) {
    const next = globalThis.structuredClone(config);
    const existing = next.models.find(entry => entry.id === nanoBananaEntry.id || entry.catalog?.model === nanoBananaEntry.catalog.model);
    if (existing) throw new Error('Nano Banana already exists; inspect the current entry before changing it');
    next.models.push({ ...globalThis.structuredClone(nanoBananaEntry), ...(pricing ? { pricing } : {}) });
    return next;
}
