const test = require('node:test');
const assert = require('node:assert/strict');
const { getVideoResultUrl } = require('./video-provider-adapters.js');

const taskId = 'cm_fixture_job';
const signed = `https://feituokuajing.com/api/video/cache/${taskId}?exp=1792043425&sig=a%2Fb%2Bc`;

test('explicit media fields accept signed download paths ending in the task ID', () => {
    for (const field of ['video_url', 'result_url', 'output_url', 'download_url']) {
        for (const wrap of [value => value, value => ({ data: value }), value => ({ result: value }),
            value => ({ output: value }), value => ({ data: [value] })]) {
            assert.equal(getVideoResultUrl({ id: taskId, status: 'completed', ...wrap({ [field]: signed }) }), signed);
        }
    }
});

test('query endpoints and unfinished responses are still excluded even in a video_url field', () => {
    for (const route of ['videos', 'videos/generations', 'video/generations', 'tasks']) {
        const query = `https://relay.example/v1/${route}/${taskId}?model=fixture`;
        assert.equal(getVideoResultUrl({ id: taskId, status: 'completed', video_url: query }), '');
    }
    assert.equal(getVideoResultUrl({ id: taskId, status: 'completed', status_url: signed, video_url: signed }), '');
    assert.equal(getVideoResultUrl({ id: taskId, status: 'completed', url: `https://relay.example/jobs/${taskId}` }), '');
    for (const status of ['queued', 'in_progress', 'failed', 'cancelled']) {
        assert.equal(getVideoResultUrl({ id: taskId, status, video_url: signed }), '');
    }
});
