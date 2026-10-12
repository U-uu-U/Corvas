import test from 'node:test';
import assert from 'node:assert/strict';
import { protocols, buildSubmitRequest, parseSubmitResponse, buildQueryRequest, parseTaskResult,
    buildContentRequest, listArtifacts, extractUsage } from './newapi-plugin.mjs';

const context = { model: 'b_seedance_v2.0', upstreamModel: 'b_seedance_v2.0', baseUrl: 'http://adapter:3011', apiKey: 'private' };
const decode = body => protocols.openai_video.decodeRequest({ ...context, body: { kind: 'json', value: body } });

test('canvas JSON references, duration and aspect ratio survive the plugin without per-second billing', () => {
    const intent = decode({ prompt: 'fixture', duration: 15, ratio: '16:9', images: [{ url: 'https://images.example/a.png' }] });
    const request = buildSubmitRequest({ ...context, requestBody: intent.requestBody });
    assert.equal(request.url, 'http://adapter:3011/v1/videos');
    assert.deepEqual(request.body, { model: context.model, prompt: 'fixture', seconds: 15, aspect_ratio: '16:9', reference_images: ['https://images.example/a.png'] });
    assert.deepEqual(extractUsage(context), {});
});

test('invalid parameters are rejected before a paid submission', () => {
    for (const values of [{ duration: 4 }, { duration: 15, seconds: 30 }, { ratio: '1:1' },
        { ratio: '16:9', aspect_ratio: '9:16' }, { images: Array(10).fill('https://images.example/a.png') },
        { images: ['https://user:pass@images.example/a.png'] }, { videos: ['https://media.example/v.mp4'] }]) {
        assert.throws(() => decode({ prompt: 'fixture', ...values }));
    }
});

test('numeric tasks stay bound to the same upstream identifier', () => {
    assert.equal(parseSubmitResponse(context, { body: { id: '123', task_id: '123' } }).taskId, '123');
    assert.equal(buildQueryRequest({ ...context, taskId: '123' }).url, 'http://adapter:3011/v1/videos/123');
    assert.throws(() => parseTaskResult({ taskId: '123' }, { id: '456', status: 'completed', video_url: 'https://cdn.example/a.mp4' }));
});

test('query outages stay nonterminal and completed video URLs never carry channel credentials', () => {
    assert.deepEqual(parseTaskResult({ taskId: '123' }, { id: '123', corvas_query_state: 'unavailable' }), { status: 'IN_PROGRESS' });
    const task = { status: 'SUCCESS', data: { video_url: 'https://cdn.example/a.mp4?signature=fixture' } };
    assert.equal(listArtifacts(task).length, 1);
    const request = buildContentRequest({ ...task, artifactKey: 'video', clientRequest: { method: 'GET' } });
    assert.equal(request.credentialless, true);
    assert.equal(request.headers, undefined);
    const output = protocols.openai_video.render({ artifacts: { video: { url: 'https://ai.ravenhash.org/v1/videos/public/content' } } }, task);
    assert.doesNotMatch(JSON.stringify(output), /cdn\.example|signature|private/);
    assert.equal(output.video_url, 'https://ai.ravenhash.org/v1/videos/public/content');
});
