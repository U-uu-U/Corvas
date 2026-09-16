import test from 'node:test';
import assert from 'node:assert/strict';
import { bindReferenceCitations, referenceCitationGuide, restoreReferenceCitations, reusablePromptConfig } from './reference-citations.js';

const citationConfig = () => ({
    prompt: 'A B C', referenceCitationIds: ['a', 'b'], referenceCitationLabels: ['图一', '图二'],
    referenceCitationOffsets: { a: 0, b: 2 },
    referenceCitationOccurrences: [
        { id: 'one', connectionId: 'a', sourceNodeId: 'node-a', offset: 0 },
        { id: 'two', connectionId: 'b', sourceNodeId: 'node-b', offset: 2 },
        { id: 'three', connectionId: 'a', sourceNodeId: 'node-a', offset: 4 }
    ]
});

test('legacy reuse removes only the exact generated guide and never reapplies expanded offsets', () => {
    const config = citationConfig();
    const text = restoreReferenceCitations(config.prompt, config);
    const guide = referenceCitationGuide(config);
    const migrated = reusablePromptConfig({ config, prompt: `${guide}\n${guide}\n${text}` });
    assert.equal(migrated.prompt, text);
    assert.deepEqual(migrated.referenceCitationOccurrences, []);
    assert.deepEqual(migrated.referenceCitationOffsets, {});
    assert.equal(restoreReferenceCitations(migrated.prompt, migrated), text);
    const prose = '参考图编号与上传顺序一致，但我要保留这句话。图一是主角。';
    assert.equal(reusablePromptConfig({ config, prompt: prose }).prompt, prose);
    assert.equal(config.referenceCitationOccurrences.length, 3);
});

test('modern drafts preserve capsules and intentional empty prompts without sharing mutable state', () => {
    const draft = { ...citationConfig(), prompt: '', generationUpstreamPrompts: ['upstream'] };
    const reused = reusablePromptConfig({ promptDraftConfig: draft, prompt: 'compiled prompt' });
    assert.deepEqual(reused, draft);
    reused.referenceCitationOccurrences[0].offset = 4;
    assert.equal(draft.referenceCitationOccurrences[0].offset, 0);
});

test('binding resolves stable nodes against actual upload order, even with new connection IDs', () => {
    const config = citationConfig();
    const before = structuredClone(config);
    const refs = [{ filePath: '/b.png' }, { filePath: '/a.png' }];
    const context = ['b', 'a'].map(id => ({ connectionId: `new-${id}`, source: { id: `node-${id}`, filePath: `/${id}.png` } }));
    const bound = bindReferenceCitations(config, refs, context);
    assert.deepEqual(bound.config.referenceCitationLabels, ['图二', '图一']);
    assert.equal(restoreReferenceCitations(config.prompt, bound.config), '图二A 图一B 图二C');
    assert.deepEqual(bound.bindings.map(entry => [entry.position, entry.sourceNodeId]), [[1, 'node-b'], [2, 'node-a']]);
    assert.deepEqual(config, before);
});

test('missing source nodes cannot be silently rebound using an old connection ID or label', () => {
    const config = citationConfig();
    const refs = [{ filePath: '/other.png' }, { filePath: '/b.png' }];
    assert.throws(() => bindReferenceCitations(config, refs, [
        { connectionId: 'a', source: { id: 'different-node', filePath: '/other.png' } }
    ]), /引用素材/);
    assert.throws(() => bindReferenceCitations(config, refs), /引用素材/);
    config.referenceCitationOccurrences[0].missing = true;
    assert.throws(() => bindReferenceCitations(config, refs), /失联/);
});

test('duplicate assets share upload numbers while bindings preserve all source nodes', () => {
    const config = citationConfig();
    const context = ['a', 'b'].map(id => ({ connectionId: id, source: { id: `node-${id}`, filePath: '/same.png' } }));
    const bound = bindReferenceCitations(config, [{ filePath: '/same.png' }], context);
    assert.deepEqual(bound.config.referenceCitationLabels, ['图一', '图一']);
    assert.equal(referenceCitationGuide(bound.config), '参考图编号与上传顺序一致：图一=第1张。');
    assert.deepEqual(bound.bindings[0].sourceNodeIds, ['node-a', 'node-b']);
});

test('uncited images remain in bindings at their original upload positions', () => {
    const bound = bindReferenceCitations({}, [{ filePath: '/first.png' }, { filePath: '/second.png' }]);
    assert.deepEqual(bound.bindings.map(entry => entry.position), [1, 2]);
    assert.deepEqual(bound.config, {});
});

test('mixed media capsules keep per-type numbering and carry material annotations into the guide', () => {
    const config = {
        prompt: 'A B C',
        referenceCitationIds: ['image-link', 'video-link', 'audio-link'],
        referenceCitationOccurrences: [
            { id: 'image-citation', connectionId: 'image-link', sourceNodeId: 'image-node', offset: 0 },
            { id: 'video-citation', connectionId: 'video-link', sourceNodeId: 'video-node', offset: 2 },
            { id: 'audio-citation', connectionId: 'audio-link', sourceNodeId: 'audio-node', offset: 4 }
        ]
    };
    const references = [
        { filePath: '/portrait.png', mediaType: 'image', annotation: '男主角' },
        { filePath: '/motion.mp4', mediaType: 'video', annotation: '动作参考' },
        { filePath: '/narration.wav', mediaType: 'audio', annotation: '旁白' }
    ];
    const context = [
        { connectionId: 'image-link', source: { id: 'image-node', filePath: '/portrait.png' } },
        { connectionId: 'video-link', source: { id: 'video-node', filePath: '/motion.mp4' } },
        { connectionId: 'audio-link', source: { id: 'audio-node', filePath: '/narration.wav' } }
    ];

    const bound = bindReferenceCitations(config, references, context);

    assert.deepEqual(bound.config.referenceCitationLabels, ['图一', '视频一', '音频一']);
    assert.equal(restoreReferenceCitations(config.prompt, bound.config), '图一A 视频一B 音频一C');
    assert.equal(referenceCitationGuide(bound.config),
        '参考素材编号与上传顺序一致：图一=第1张，视频一=第1个，音频一=第1段。素材用途标注：图一=男主角；视频一=动作参考；音频一=旁白。');
    assert.deepEqual(bound.bindings.map(entry => [entry.mediaType, entry.label, entry.annotation]), [
        ['image', '图一', '男主角'],
        ['video', '视频一', '动作参考'],
        ['audio', '音频一', '旁白']
    ]);
});
