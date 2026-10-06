// Public success results contain local products, not provider response envelopes.
const RESULT_FIELDS = [
    'success', 'provider', 'taskId', 'filePath', 'filePaths', 'mediaType', 'width', 'height',
    'targetDir', 'requestedTargetDir', 'targetDirFallback', 'projectId', 'nodeId', 'recovered',
    'sourceReferences', 'videoReferences', 'audioReferences', 'missingSourceReferences', 'plan'
];
const OUTPUT_URL_FIELDS = ['url', 'video', 'video_url', 'videoUrl', 'download_url', 'downloadUrl',
    'output_url', 'outputUrl', '_resultUrl', 'rawResponse', 'response', 'location'];

function localVideoItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const copy = structuredClone(item);
    for (const field of OUTPUT_URL_FIELDS) delete copy[field];
    // Limit cleanup to generated product slots. Prompts and user references are inputs.
    if (Array.isArray(copy.resultUrls)) copy.resultUrls = [];
    if (Array.isArray(copy.resultEntries)) copy.resultEntries = copy.resultEntries.map(entry => {
        if (!entry || typeof entry !== 'object') return entry;
        return { filePath: entry.filePath || entry.item?.filePath || '', url: '', item: localVideoItem(entry.item) || null };
    });
    if (Array.isArray(copy.resultItems)) copy.resultItems = copy.resultItems.map(localVideoItem);
    return copy;
}

function publicVideoResult(result) {
    // Failure classification belongs to the existing structured-error pipeline.
    if (!result || typeof result !== 'object' || result.success === false) return result;
    const output = Object.fromEntries(RESULT_FIELDS.filter(key => Object.hasOwn(result, key))
        .map(key => [key, structuredClone(result[key])]));
    if (Object.hasOwn(result, 'item')) output.item = localVideoItem(result.item);
    if (Array.isArray(result.images)) output.images = result.images.map(localVideoItem);
    return output;
}

module.exports = { publicVideoResult };
