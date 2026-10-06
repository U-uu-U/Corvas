const test = require('node:test');
const assert = require('node:assert/strict');
const { publicVideoResult } = require('./video-result-privacy.cjs');
const privateUrl = 'https://private-video-provider.test/output.mp4?signature=private-signature';

test('video success uses a fixed public contract and discards unknown provider envelopes', () => {
    const original = { success: true, provider: 'openai-video', taskId: 'task-1', filePath: '/output.mp4',
        filePaths: ['/output.mp4'], mediaType: 'video', width: 1280, height: 720,
        url: privateUrl, video: { url: privateUrl }, output_url: privateUrl,
        rawResponse: { data: { url: privateUrl } }, futureProviderField: { url: privateUrl } };
    const before = structuredClone(original);
    const result = publicVideoResult(original);
    assert.deepEqual(result, { success: true, provider: 'openai-video', taskId: 'task-1', filePath: '/output.mp4',
        filePaths: ['/output.mp4'], mediaType: 'video', width: 1280, height: 720 });
    assert.deepEqual(original, before);
    result.filePaths.push('/another.mp4');
    assert.deepEqual(original.filePaths, ['/output.mp4']);
});

test('legacy generated product URL slots are removed without censoring user prompts or references', () => {
    const userUrl = 'https://user-reference.test/reference.mp4';
    const record = { prompt: `Describe ${userUrl}`, references: [{ filePath: userUrl }] };
    const original = { filePath: '/output.mp4', taskId: 'old',
        sourceReferences: [{ filePath: userUrl }],
        item: { id: 'generated', filePath: '/output.mp4', url: privateUrl, generation: record,
            resultUrls: [privateUrl], resultFilePaths: ['/output.mp4'],
            resultEntries: [{ filePath: '/output.mp4', url: privateUrl,
                item: { id: 'candidate', filePath: '/output.mp4', url: privateUrl, generation: record } }],
            resultItems: [{ filePath: '/output.mp4', video: { url: privateUrl } }] } };
    const before = structuredClone(original);
    const result = publicVideoResult(original);
    assert.doesNotMatch(JSON.stringify(result), /private-video-provider|private-signature/);
    assert.deepEqual(result.item.generation, record);
    assert.equal(result.sourceReferences[0].filePath, userUrl);
    assert.equal(result.item.resultEntries[0].item.id, 'candidate');
    assert.deepEqual(result.item.resultFilePaths, ['/output.mp4']);
    assert.deepEqual(original, before);
});

test('structured errors keep the existing classifier and recovery metadata', () => {
    const failure = { success: false, code: 'RH_SUBMISSION_UNKNOWN', taskId: 'existing',
        submissionUnknown: true, parameterIssues: [{ parameter: 'duration', max: 12 }] };
    assert.strictEqual(publicVideoResult(failure), failure);
});
