export const meta = {
    apiVersion: 1, key: 'ravenhash-seedance20', name: 'Seedance 2.0 15s', version: '1.0.0', author: { name: 'RavenHash' },
    description: { en: 'Fixed 15-second video with up to 9 reference images', zh: '固定15秒，最多9张参考图' },
    models: ['b_seedance_v2.0'], fetchMode: 'per_task', protocols: ['openai_video'],
    baseUrl: 'http://seedance-direct-adapter:3011', usageSchema: {}
};

function numericTask(value) {
    const task = String(value || '');
    if (!/^[1-9][0-9]{0,18}$/.test(task)) throw new Error('Invalid task identifier');
    return task;
}

function publicURL(value) {
    if (typeof value !== 'string' || !/^https?:\/\/[^\s/@?#]+(?:[/?#]|$)/i.test(value)) {
        throw new Error('A public HTTP(S) reference URL is required');
    }
    return value;
}

function requestBody(req, model) {
    if (model !== 'b_seedance_v2.0') throw new Error('Unsupported video model');
    if (typeof req.prompt !== 'string' || !req.prompt.trim()) throw new Error('prompt is required');
    const durations = ['duration', 'seconds'].filter(key => req[key] !== undefined).map(key => req[key]);
    if (durations.some(value => value !== 15 && value !== '15')) throw new Error('This model requires exactly 15 seconds');
    const ratios = ['ratio', 'aspect_ratio'].filter(key => req[key] !== undefined).map(key => req[key]);
    const ratio = ratios[0] || '9:16';
    if (!['9:16', '16:9'].includes(ratio) || ratios.some(value => value !== ratio)) throw new Error('Use 9:16 or 16:9 without conflicting ratio fields');
    if (['videos', 'video_urls', 'reference_videos', 'audios', 'audio_urls', 'reference_audios'].some(key => req[key]?.length)) {
        throw new Error('This model only supports image references');
    }
    const sources = ['reference_images', 'image_urls', 'images'].filter(key => req[key] !== undefined).map(key => req[key]);
    const images = sources[0] || [];
    if (!Array.isArray(images) || images.length > 9) throw new Error('At most 9 image references are supported');
    if (sources.some(value => JSON.stringify(value) !== JSON.stringify(images))) throw new Error('Conflicting image reference fields');
    const normalized = images.map(value => publicURL(typeof value === 'object' && value ? value.url || value.image_url : value));
    if (req.input_reference) {
        if (normalized.length) throw new Error('Use images or input_reference, not both');
        normalized.push(publicURL(req.input_reference));
    }
    return { model, prompt: req.prompt, seconds: 15, aspect_ratio: ratio, reference_images: normalized };
}

export function buildSubmitRequest(ctx) {
    return { url: ctx.baseUrl + '/v1/videos', method: 'POST',
        headers: { Authorization: 'Bearer ' + ctx.apiKey, 'Content-Type': 'application/json' },
        body: requestBody(ctx.requestBody || {}, ctx.upstreamModel || ctx.model) };
}

export function parseSubmitResponse(_ctx, response) {
    const body = response.body || {};
    const taskId = numericTask(body.task_id || body.id);
    if (body.id && body.task_id && String(body.id) !== String(body.task_id)) throw new Error('Conflicting task identifiers');
    return { taskId, taskData: { status: body.status || 'queued' } };
}

export function buildQueryRequest(ctx) {
    return { url: ctx.baseUrl + '/v1/videos/' + numericTask(ctx.taskId), method: 'GET',
        headers: { Authorization: 'Bearer ' + ctx.apiKey } };
}

export function parseTaskResult(ctx, body) {
    if (numericTask(body.task_id || body.id) !== numericTask(ctx.taskId)) throw new Error('Task response mismatch');
    if (body.corvas_query_state === 'unavailable') return { status: 'IN_PROGRESS' };
    const states = { queued: 'QUEUED', in_progress: 'IN_PROGRESS', completed: 'SUCCESS', failed: 'FAILURE' };
    const status = states[body.status] || 'UNKNOWN';
    if (status === 'SUCCESS') return { status, progress: '100%', url: publicURL(body.video_url) };
    if (status === 'FAILURE') return { status, reason: String(body.error?.message || 'Video generation failed') };
    return { status };
}

export function extractUsage() { return {}; }

export function listArtifacts(task) {
    return task.status === 'SUCCESS' && task.data?.video_url ? [{ key: 'video', type: 'video', mimeType: 'video/mp4' }] : [];
}

export function buildContentRequest(ctx) {
    if (ctx.artifactKey !== 'video') throw new Error('artifact_not_found');
    return { url: publicURL(ctx.data?.video_url), method: ctx.clientRequest.method, credentialless: true };
}

export const protocols = {
    openai_video: {
        decodeRequest(ctx) {
            if (ctx.body?.kind !== 'json' || !ctx.body.value || Array.isArray(ctx.body.value)) throw new Error('Use JSON with public image URLs');
            const body = requestBody(ctx.body.value, ctx.model);
            return { kind: 'submit', model: ctx.model, action: body.reference_images.length ? 'image_to_video' : 'text_to_video', requestBody: body };
        },
        render(ctx, task) {
            const video = ctx.artifacts?.video?.url;
            return { seconds: 15, ...(task.status === 'SUCCESS' && video ? { video_url: video } : {}),
                ...(task.status === 'FAILURE' ? { error: { code: 'video_generation_failed', message: '视频生成失败，请联系管理员查询任务记录' } } : {}) };
        }
    }
};
