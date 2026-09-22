import { describeModelPresentation } from './model-presentation.mjs';

const RAVENHASH_VIDEO_HOSTS = new Set(['art.ravenhash.org', 'cart.ravenhash.org']);
const STARFRAME_VIDEO_HOSTS = new Set(['api.xzapi.vip', ...RAVENHASH_VIDEO_HOSTS]);

export const VIDEO_MODEL_PROFILES = [
    {
        matchModel: /^oc-model-qbdmeb$/i,
        label: 'dola（9图15秒）', routeLabel: 'dola',
        ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
        resolutions: ['720p'], durations: [5, 10, 15], durationControl: 'select',
        supportsWebSearch: false, supportsCameraFixed: false, supportsGeneratedAudio: false, supportsWatermark: false,
        referenceLimits: { image: 10, video: 0, audio: 0 }, defaultRatio: '16:9', defaultResolution: '720p', defaultDuration: 15
    },
    {
        matchModel: /^oc-model-1iq31f$/i,
        label: 'sd-2.0（官渠）-极稳', routeLabel: 'SD2.0 官渠',
        ratios: ['16:9', '9:16'], resolutions: ['480p', '720p', '1080p'],
        durations: Array.from({ length: 11 }, (_, index) => index + 5), durationControl: 'slider',
        supportsWebSearch: false, supportsCameraFixed: false, supportsGeneratedAudio: false, supportsWatermark: false,
        referenceLimits: { image: 9, video: 0, audio: 0 }, defaultRatio: '16:9', defaultResolution: '720p', defaultDuration: 10
    },
    {
        matchModel: /^oc-model-(?:bkb50q|c6ws7e)$/i,
        label: 'S-2.0 933',
        ratios: ['16:9', '9:16'], resolutions: ['720p'],
        durations: Array.from({ length: 12 }, (_, index) => index + 4), durationControl: 'slider',
        supportsWebSearch: false, supportsCameraFixed: false, supportsGeneratedAudio: false, supportsWatermark: false,
        defaultRatio: '16:9', defaultResolution: '720p', defaultDuration: 10
    },
    {
        matchModel: /^seedance-2\.5-pro$/i,
        label: 'Seedance 2.5 Pro',
        ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
        resolutions: ['480p', '720p'],
        durations: Array.from({ length: 27 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 30, video: 10, audio: 10 },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '720p',
        defaultDuration: 4
    },
    {
        matchModel: /^ch0107-sd-2\.5-720p$/i,
        label: 'Seedance 2.5 720p',
        routeLabel: 'StarFrame CH0107',
        ratios: ['16:9'],
        resolutions: ['720p'],
        durations: Array.from({ length: 27 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 30, video: 10, audio: 10 },
        defaultRatio: '16:9',
        resolveAdaptiveRatio: false,
        defaultResolution: '720p',
        defaultDuration: 4
    },
    {
        matchModel: /^sd_2\.5_discount_v1$/i,
        label: 'Seedance 2.5',
        routeLabel: 'GlobalAiOpc',
        ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
        resolutions: ['480p', '720p', '1080p'],
        durations: Array.from({ length: 27 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: true,
        supportsWatermark: false,
        referenceLimits: { image: 30, video: 10, audio: 10 },
        defaultRatio: '16:9',
        resolveAdaptiveRatio: false,
        defaultResolution: '720p',
        defaultDuration: 4
    },
    {
        matchModel: /^sd2(?:\.5|_5|-5)(?:-route[12]|-haidiyue-face)?$/i,
        label: 'Seedance 2.5',
        routeLabel: '线路二',
        routeGroup: 'seedance25-fixed',
        routeGroupLabel: 'Seedance 2.5 · 固定 30 秒',
        routeModelLabel: 'sd2.5',
        ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
        resolutions: ['720p'],
        durations: [30],
        durationControl: 'fixed',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 9, video: 0, audio: 0 },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '720p',
        defaultDuration: 30
    },
    {
        matchModel: /^seedance_v2\.5$/i,
        label: 'HM-Seedance 2.5',
        ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
        resolutions: ['720p'],
        durations: Array.from({ length: 27 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 10, video: 0, audio: 0 },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '720p',
        defaultDuration: 30
    },
    ...[
        ['seedance_v2.0-933', 'HM-Seedance V2.0 933', 15, 9, 3, 3],
        ['seedance_v2.5-101010', 'HM-Seedance V2.5 101010', 30, 10, 10, 10],
        ['seedance_v2.5-301010', 'HM-Seedance V2.5 301010', 30, 30, 10, 10]
    ].map(([model, label, maxDuration, image, video, audio]) => ({
        matchModel: new RegExp(`^${model.replaceAll('.', '\\.')}$`, 'i'),
        label,
        faceRestriction: true,
        ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
        resolutions: ['720p'],
        durations: Array.from({ length: maxDuration - 3 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image, video, audio },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '720p',
        defaultDuration: maxDuration
    })),
    {
        match: /seedance[^a-z0-9]*(?:v[^a-z0-9]*)?2[._-]?5/i,
        label: 'Seedance 2.5',
        ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
        resolutions: ['720p'],
        durations: Array.from({ length: 27 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 10, video: 0, audio: 0 },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '720p',
        defaultDuration: 30
    },
    {
        match: /seedance[^a-z0-9]*2(?:[._-]?0)?|doubao-seedance-2|artsdance[^a-z0-9]*2/i,
        label: 'Seedance 2.0',
        ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
        resolutions: ['480p', '720p', '1080p', '4K'],
        durations: Array.from({ length: 15 }, (_, index) => index + 1),
        durationControl: 'slider',
        supportsWebSearch: true,
        defaultRatio: '16:9',
        defaultResolution: '1080p',
        defaultDuration: 5
    },
    {
        match: /minimax[^a-z0-9]*h3/i,
        label: 'MiniMax H3',
        ratios: ['adaptive', '16:9', '9:16', '1:1', '2:3', '3:2', '4:3', '3:4', '21:9'],
        resolutions: ['2k', '4k', '1080p', '768p', '480p'],
        durations: Array.from({ length: 12 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 9, video: 3, audio: 3 },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '2k',
        defaultDuration: 4
    }
];

export const DEFAULT_VIDEO_MODEL_PROFILE = {
    label: '未收录模型',
    ratios: [],
    resolutions: [],
    durations: [],
    durationControl: null,
    supportsWebSearch: false,
    supportsCameraFixed: false,
    supportsGeneratedAudio: false,
    supportsWatermark: false,
    defaultRatio: null,
    defaultResolution: null,
    defaultDuration: null
};

export function getVideoModelProfile(provider) {
    if (!provider?.model) return null;
    const model = String(provider.model).trim();
    const marker = `${provider.model} ${provider.name || ''} ${provider.endpoint || ''}`;
    let profile = VIDEO_MODEL_PROFILES.find(entry => entry.matchModel?.test(model))
        || VIDEO_MODEL_PROFILES.find(entry => entry.match?.test(marker))
        || DEFAULT_VIDEO_MODEL_PROFILE;
    let host = '';
    try { host = new URL(provider.endpoint).hostname; } catch (_) { /* Unconfigured endpoint. */ }
    const cartPrice = {
        'seedance-2.5-pro': [1.25, 'second'],
        'ch0107-sd-2.5-720p': [1.25, 'second'],
        'sd2.5': [6.86, 'request'],
        'sd2.5-route1': [6.86, 'request'],
        'seedance_v2.5': [5.72, 'request'],
        'seedance_v2.0-933': [7.43, 'request'],
        'seedance_v2.5-101010': [8, 'request'],
        'seedance_v2.5-301010': [11.43, 'request']
    }[model.toLowerCase()];
    const shanhaiPrice = {
        'oc-model-qbdmeb': [4, 'request'],
        'oc-model-1iq31f': [5, 'second'],
        'oc-model-bkb50q': [7, 'request'],
        'oc-model-c6ws7e': [7, 'request']
    }[model.toLowerCase()];
    if (host === 'shanhai.vnshu.cn' && shanhaiPrice) {
        return { ...profile, price: { amount: shanhaiPrice[0], currency: 'CNY', unit: shanhaiPrice[1], kind: 'sale',
            source: 'shanhai configured sale', updatedAt: '2026-09-22T00:00:00Z' } };
    }
    if (host === 'cart.ravenhash.org' && cartPrice) {
        const base = getVideoModelProfile({ ...provider, endpoint: 'https://art.ravenhash.org/v1' });
        return { ...base, price: { amount: cartPrice[0], currency: 'CNY', unit: cartPrice[1], kind: 'sale',
            source: 'cart configured sale', updatedAt: '2026-09-21T02:52:08Z' } };
    }
    if (model.toLowerCase() === 'seedance-2.5-pro' && RAVENHASH_VIDEO_HOSTS.has(host)) {
        return { ...profile, price: { amount: 1.06, currency: 'CNY', unit: 'second', kind: 'sale',
            source: 'ravenhash configured sale', updatedAt: '2026-09-20T00:00:00Z' } };
    }
    if (/^ch0107-sd-2\.5-720p$/i.test(model) && STARFRAME_VIDEO_HOSTS.has(host)) return { ...profile, price: {
        amount: 1.06, currency: 'CNY', unit: 'second', kind: 'sale',
        source: 'user configured sale', updatedAt: '2026-09-20T12:00:00Z'
    } };
    const fixedSeedance = profile.routeGroup === 'seedance25-fixed';
    if (fixedSeedance) {
        profile = { ...profile, routeLabel: /-route1$/i.test(model) ? '线路一' : '线路二', recommended: /-route1$/i.test(model) };
    }
    if (fixedSeedance && RAVENHASH_VIDEO_HOSTS.has(host)) {
        return {
            ...profile,
            price: {
                amount: 6, currency: 'CNY', unit: 'request', kind: 'sale',
                source: 'ravenhash configured sale', updatedAt: '2026-09-06T12:38:30Z'
            }
        };
    }
    const hmPrice = {
        'seedance_v2.5': 5,
        'seedance_v2.0-933': 6.5,
        'seedance_v2.5-101010': 7,
        'seedance_v2.5-301010': 10
    }[model.toLowerCase()];
    if (hmPrice && RAVENHASH_VIDEO_HOSTS.has(host)) {
        return { ...profile, price: {
            amount: hmPrice, currency: 'CNY', unit: 'request', kind: 'sale',
            source: 'ravenhash configured sale', updatedAt: '2026-09-12T11:30:00Z'
        } };
    }
    return profile;
}

export function getVideoModelGroup(provider) {
    let host = '';
    try { host = new URL(provider?.endpoint).hostname.toLowerCase(); } catch { return {}; }
    const model = String(provider?.model || '').toLowerCase();
    const shanhaiLabels = {
        'oc-model-qbdmeb': 'dola（9图15秒）',
        'oc-model-1iq31f': 'sd-2.0（官渠）-极稳',
        'oc-model-bkb50q': 'S-2.0 官转933',
        'oc-model-c6ws7e': 'S-2.0 满血933（不卡人脸）'
    };
    if (host === 'shanhai.vnshu.cn' && shanhaiLabels[model]) {
        return { label: shanhaiLabels[model], routeLabel: shanhaiLabels[model], routeModelLabel: provider.model,
            routeGroup: 'shanhai-backup-2', routeGroupLabel: '备用分组2',
            routeGroupScope: 'catalog', routeGroupOrder: 30,
            routeOrder: ['oc-model-qbdmeb', 'oc-model-1iq31f', 'oc-model-bkb50q', 'oc-model-c6ws7e'].indexOf(model),
            routeGroupAlways: true, recommended: false };
    }
    if (STARFRAME_VIDEO_HOSTS.has(host) && model === 'ch0107-sd-2.5-720p') {
        const label = '2.5pro 备用（满参）';
        return { label, routeLabel: label, routeModelLabel: provider.model,
            routeGroup: 'seedance25-backup', routeGroupLabel: 'Seedance 2.5 备用渠道',
            routeGroupScope: 'catalog', routeGroupOrder: 20, routeOrder: 1,
            routeGroupAlways: true, recommended: false };
    }
    const variant = /^artsdance2-0-(fast|mini|pro)-intl-260701$/.exec(model)?.[1];
    if (RAVENHASH_VIDEO_HOSTS.has(host) && variant) {
        const label = `Seedance 2.0 ${variant[0].toUpperCase()}${variant.slice(1)}`;
        return { label, routeLabel: label, routeModelLabel: provider.model,
            routeGroup: 'seedance20-recommended', routeGroupLabel: 'Seedance 2.0 推荐渠道',
            routeGroupDescription: '可NSFW 无限制', routeGroupOrder: 100,
            routeOrder: ['fast', 'mini', 'pro'].indexOf(variant), routeGroupAlways: true };
    }
    if (RAVENHASH_VIDEO_HOSTS.has(host) && model === 'sd2.5-route1') {
        return { routeGroup: 'seedance25-backup', routeGroupLabel: 'Seedance 2.5 备用渠道',
            routeLabel: 'Seedance 2.5 固定 30 秒（过人脸）', routeModelLabel: provider.model,
            routeGroupScope: 'catalog', routeGroupOrder: 20, routeOrder: 0, routeGroupAlways: true, recommended: false };
    }
    const labels = {
        'seedance-2.5-pro': 'Seedance 2.5 Pro（满血满参）',
        'seedance_v2.5': 'HM-Seedance 2.5',
        'seedance_v2.0-933': 'HM-Seedance 2.0 933',
        'seedance_v2.5-101010': 'HM-Seedance 2.5 101010',
        'seedance_v2.5-301010': 'HM-Seedance 2.5 301010',
        'sd2.5': 'SD2.5 固定 30 秒（电商效果优化）'
    };
    const label = labels[model];
    if (host !== 'video.zhubo.asia' && (!RAVENHASH_VIDEO_HOSTS.has(host) || !label)) return {};
    return { label: label || provider.model, routeGroup: 'zhubo-video', routeGroupLabel: 'Seedance 2.5 推荐渠道',
        routeLabel: label || provider.model, routeModelLabel: provider.model, routeGroupAlways: true,
        routeGroupOrder: 10, routeOrder: ({ 'sd2.5': 0, 'seedance-2.5-pro': 1, 'seedance_v2.5': 2,
            'seedance_v2.0-933': 3 })[model] ?? 10, recommended: false };
}

export function describeVideoModelProfile(profile, options) {
    if (!profile) return '';
    const parts = [];
    if (profile.faceRestriction) parts.push('人脸参考受限');
    if (profile.resolutions?.length) parts.push(profile.resolutions.join('/'));
    if (profile.durations?.length) {
        const min = Math.min(...profile.durations);
        const max = Math.max(...profile.durations);
        parts.push(min === max ? `固定 ${max} 秒` : `${min}-${max} 秒`);
    }
    if (profile.referenceLimits) {
        const { image = 0, video = 0, audio = 0 } = profile.referenceLimits;
        const media = [image ? `${image} 图` : '', video ? `${video} 视频` : '', audio ? `${audio} 音频` : ''].filter(Boolean);
        if (media.length) parts.push(`最多 ${media.join(' / ')}参考`);
        if (!video && !audio) parts.push('不支持音视频参考');
    }
    return describeModelPresentation(profile, parts.join('；'), options);
}
