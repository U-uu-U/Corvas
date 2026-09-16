const MEDIA_LABELS = Object.freeze({
    image: { prefix: '图', unit: '张' },
    video: { prefix: '视频', unit: '个' },
    audio: { prefix: '音频', unit: '段' }
});
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'ico', 'avif', 'heic', 'heif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'aac', 'flac', 'ogg', 'wma', 'm4a']);

export function normalizeReferenceAnnotation(value) {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function referenceMediaType(reference = {}) {
    const explicit = String(reference.mediaType || reference.kind || '').toLowerCase();
    if (Object.hasOwn(MEDIA_LABELS, explicit)) return explicit;
    const extension = String(reference.filePath || reference.url || '').split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) return 'image';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
    if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
    return 'file';
}

export function referenceMaterialLabel(mediaType, index) {
    const definition = MEDIA_LABELS[mediaType] || { prefix: '素材', unit: '个' };
    const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    return `${definition.prefix}${numerals[index] || index + 1}`;
}

function referenceLabelIdentity(label) {
    const value = String(label || '').trim();
    const match = /^(图|视频|音频|素材)(一|二|三|四|五|六|七|八|九|十|\d+)$/.exec(value);
    if (!match) return null;
    const chineseNumerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    const chineseIndex = chineseNumerals.indexOf(match[2]);
    const position = chineseIndex >= 0 ? chineseIndex + 1 : Number(match[2]);
    const mediaType = { '图': 'image', '视频': 'video', '音频': 'audio' }[match[1]] || 'file';
    return Number.isFinite(position) && position > 0 ? { mediaType, position } : null;
}

function referenceUploadDescription(label) {
    const identity = referenceLabelIdentity(label);
    if (!identity) return label;
    const definition = MEDIA_LABELS[identity.mediaType] || { unit: '个' };
    return `第${identity.position}${definition.unit}`;
}

export function restoreReferenceCitations(prompt, config = {}) {
    const text = String(prompt || '');
    const ids = Array.isArray(config.referenceCitationIds) ? config.referenceCitationIds : [];
    const labels = Array.isArray(config.referenceCitationLabels) ? config.referenceCitationLabels : [];
    const offsets = config.referenceCitationOffsets && typeof config.referenceCitationOffsets === 'object'
        ? config.referenceCitationOffsets
        : {};
    const occurrences = Array.isArray(config.referenceCitationOccurrences)
        ? config.referenceCitationOccurrences
        : ids.map(id => ({ connectionId: id, offset: offsets[id] }));
    const insertions = occurrences.map((entry, index) => ({
        index,
        label: String(labels[ids.indexOf(entry.connectionId)] || '').trim(),
        offset: Number(entry.offset)
    })).filter(entry => entry.label && Number.isFinite(entry.offset) && entry.offset >= 0 && entry.offset <= text.length);

    let restored = text;
    insertions
        .sort((left, right) => right.offset - left.offset || right.index - left.index)
        .forEach(entry => {
            restored = `${restored.slice(0, entry.offset)}${entry.label}${restored.slice(entry.offset)}`;
        });
    return restored;
}

export function referenceCitationGuide(config = {}) {
    const materialNotes = Array.isArray(config.referenceMaterialNotes) ? config.referenceMaterialNotes : [];
    const labels = materialNotes.length
        ? materialNotes.map(entry => entry?.label).filter(label => typeof label === 'string' && label.trim())
        : Array.isArray(config.referenceCitationLabels)
            ? config.referenceCitationLabels.filter(label => typeof label === 'string' && label.trim())
            : [];
    const mappings = [...new Set(labels)].map(label => {
        const normalized = label.trim();
        return `${normalized}=${referenceUploadDescription(normalized)}`;
    });
    if (!mappings.length) return '';
    const imageOnly = mappings.every(mapping => mapping.startsWith('图'));
    const numbering = `${imageOnly ? '参考图' : '参考素材'}编号与上传顺序一致：${mappings.join('，')}。`;
    const annotations = materialNotes
        .map(entry => ({ label: String(entry?.label || '').trim(), annotation: normalizeReferenceAnnotation(entry?.annotation) }))
        .filter(entry => entry.label && entry.annotation);
    if (!annotations.length) return numbering;
    return `${numbering}素材用途标注：${annotations.map(entry => `${entry.label}=${entry.annotation}`).join('；')}。`;
}

export function withoutReferenceCitationGuide(prompt, config = {}) {
    const guide = referenceCitationGuide(config);
    const text = String(prompt || '');
    return guide && text.startsWith(`${guide}\n`) ? text.slice(guide.length + 1) : text;
}

export function reusablePromptConfig(record = {}) {
    const config = JSON.parse(JSON.stringify(record.promptDraftConfig || record.config || {}));
    if (record.promptDraftConfig) return config;
    let prompt = String(record.prompt ?? record.requestPrompt ?? config.prompt ?? '');
    let next = withoutReferenceCitationGuide(prompt, config);
    while (next !== prompt) {
        prompt = next;
        next = withoutReferenceCitationGuide(prompt, config);
    }
    config.prompt = prompt;
    for (const key of ['referenceCitationIds', 'referenceCitationLabels', 'referenceCitationOffsets',
        'referenceCitationOccurrences', 'referenceCitationAnnotations', 'referenceMaterialNotes']) {
        if (Object.hasOwn(config, key)) config[key] = key.endsWith('Offsets') || key.endsWith('Annotations') ? {} : [];
    }
    return config;
}

export function bindReferenceCitations(config, references, context = []) {
    const snapshot = JSON.parse(JSON.stringify(config || {}));
    const ids = snapshot.referenceCitationIds || [];
    const labels = snapshot.referenceCitationLabels || [];
    const occurrences = snapshot.referenceCitationOccurrences || [];
    if (occurrences.some(entry => entry?.missing)) throw new Error('引用素材已失联，请重新连接素材或移除失联胶囊');

    const typePaths = new Map();
    const descriptors = references.map((reference, index) => {
        const mediaType = referenceMediaType(reference);
        if (!typePaths.has(mediaType)) typePaths.set(mediaType, []);
        const paths = typePaths.get(mediaType);
        const key = String(reference.filePath || reference.url || `position:${index}`);
        let typePosition = paths.indexOf(key) + 1;
        if (!typePosition) {
            paths.push(key);
            typePosition = paths.length;
        }
        const referenceNodeId = reference.sourceNodeId || reference.nodeId || null;
        const sources = context.filter(entry => (referenceNodeId && sourceNodeId(entry) === referenceNodeId)
            || sourceFilePaths(entry).includes(reference.filePath));
        const source = sources[0];
        const annotation = normalizeReferenceAnnotation(
            reference.annotation || reference.referenceAnnotation
            || source?.source?.referenceAnnotation || source?.referenceAnnotation
        );
        return {
            reference,
            sourceNodeId: referenceNodeId,
            position: index + 1,
            typePosition,
            mediaType,
            label: referenceMaterialLabel(mediaType, typePosition - 1),
            annotation,
            sources,
            source
        };
    });

    const cited = ids.map((connectionId, index) => {
        const occurrence = occurrences.find(entry => entry.connectionId === connectionId);
        const source = context.find(entry => occurrence?.sourceNodeId
            ? entry.sourceNodeId === occurrence.sourceNodeId || entry.source?.id === occurrence.sourceNodeId
            : entry.connectionId === connectionId);
        const stableSourceNodeId = occurrence?.sourceNodeId || sourceNodeId(source);
        let descriptor = source
            ? descriptors.find(entry => (stableSourceNodeId && entry.sourceNodeId === stableSourceNodeId)
                || sourceFilePaths(source).includes(entry.reference.filePath))
            : stableSourceNodeId
                ? descriptors.find(entry => entry.sourceNodeId === stableSourceNodeId)
            : null;
        if (!descriptor && !context.length && !occurrence?.sourceNodeId) {
            const identity = referenceLabelIdentity(labels[index]);
            descriptor = identity ? descriptors.find(entry => entry.mediaType === identity.mediaType
                && entry.typePosition === identity.position) : null;
        }
        if (!descriptor) throw new Error('引用素材与上传列表不一致，请重新连接素材');
        return {
            connectionId,
            sourceNodeId: occurrence?.sourceNodeId || source?.sourceNodeId || source?.source?.id || null,
            filePath: descriptor.reference.filePath,
            position: descriptor.position,
            mediaType: descriptor.mediaType,
            label: descriptor.label,
            annotation: normalizeReferenceAnnotation(occurrence?.annotation || descriptor.annotation)
        };
    });
    if (ids.length) {
        snapshot.referenceCitationLabels = cited.map(entry => entry.label);
        snapshot.referenceCitationAnnotations = Object.fromEntries(cited
            .filter(entry => entry.annotation).map(entry => [entry.connectionId, entry.annotation]));
        const savedOccurrences = Array.isArray(snapshot.referenceCitationOccurrences) ? occurrences
            : ids.map(connectionId => ({ connectionId, offset: snapshot.referenceCitationOffsets?.[connectionId] }));
        snapshot.referenceCitationOccurrences = savedOccurrences.map((entry, index) => ({
            ...entry,
            id: entry.id || `citation-${index}-${entry.connectionId}`,
            sourceNodeId: entry.sourceNodeId || cited.find(binding => binding.connectionId === entry.connectionId)?.sourceNodeId,
            annotation: cited.find(binding => binding.connectionId === entry.connectionId)?.annotation || ''
        }));
    }

    const bindings = descriptors.map(descriptor => ({
        position: descriptor.position,
        typePosition: descriptor.typePosition,
        filePath: descriptor.reference.filePath,
        mediaType: descriptor.mediaType,
        label: descriptor.label,
        annotation: descriptor.annotation,
        sourceNodeIds: [...new Set(descriptor.sources
            .map(entry => entry.sourceNodeId || entry.source?.id).filter(Boolean))],
        sourceNodeId: descriptor.source?.sourceNodeId || descriptor.source?.source?.id || null,
        ...cited.find(binding => binding.position === descriptor.position)
    }));
    if (bindings.some(entry => entry.annotation)) {
        snapshot.referenceMaterialNotes = bindings.map(entry => ({
            label: entry.label,
            mediaType: entry.mediaType,
            sourceNodeId: entry.sourceNodeId,
            annotation: entry.annotation
        }));
    } else {
        delete snapshot.referenceMaterialNotes;
    }
    return { config: snapshot, bindings };
}

function sourceFilePaths(entry) {
    return [entry.source?.filePath, ...(entry.values || []).filter(value => typeof value === 'string' && value.startsWith('local-res://'))
        .map(value => {
            try { return decodeURIComponent(value.slice('local-res://'.length)); }
            catch { return value.slice('local-res://'.length); }
        })].filter(Boolean);
}

function sourceNodeId(entry) {
    return entry?.sourceNodeId || entry?.source?.id || null;
}
