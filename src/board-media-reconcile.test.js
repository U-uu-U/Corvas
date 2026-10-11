import test from 'node:test';
import assert from 'node:assert/strict';
import mediaPolicy from '../shared/board-media-policy.cjs';
import { findUnavailableBoardItems, pruneBoardMedia } from './board-media-reconcile.js';

test('board media excludes documents, source projects and temporary files without banning underscore names', () => {
    for (const file of ['photo.jpg', 'frame.PNG', 'clip.mp4', 'voice.mp3', '_a1.png', 'scan.tif']) {
        assert.equal(mediaPolicy.isBoardMediaFile(file), true, file);
    }
    for (const file of ['slides.pptx', 'page.html', 'drawing.psd', 'model.glb', 'report.pdf', 'notes.txt',
        '~$slides.pptx', '.photo.png', '._photo.png', 'photo.png.part', 'image', 'png', 'mp4']) {
        assert.equal(mediaPolicy.isBoardMediaFile(file), false, file);
    }
});

test('cleanup only removes confirmed missing media under reachable roots and non-media cards', async () => {
    const paths = {
        'E:\\media': { success: true, exists: true, isFile: false },
        'Z:\\offline': { success: true, exists: false, error: 'ENOENT' },
        'E:/media/good.png': { success: true, exists: true, isFile: true, size: 120 },
        'e:/MEDIA/missing.png': { success: true, exists: false, error: 'ENOENT' },
        'E:/media/locked.png': { success: true, exists: false, error: 'EACCES' },
        'E:/media/empty.png': { success: true, exists: true, isFile: true, size: 0 }
    };
    const items = [
        { id: 'good', filePath: 'E:/media/good.png' },
        { id: 'missing', filePath: 'e:/MEDIA/missing.png' },
        { id: 'locked', filePath: 'E:/media/locked.png' },
        { id: 'empty', filePath: 'E:/media/empty.png' },
        { id: 'external', filePath: 'E:/media-other/absent.png' },
        { id: 'offline', filePath: 'Z:/offline/photo.png' },
        { id: 'slides', filePath: 'E:/media/deck.pptx' },
        { id: 'generator', kind: 'op', nodeType: 'image', filePath: 'E:/media/old.png' },
        { id: 'note', kind: 'op', nodeType: 'text' }
    ];
    const removed = await findUnavailableBoardItems(items, { folders: ['E:\\media', 'Z:\\offline'], platform: 'win32',
        inspect: file => Promise.resolve(paths[file]) });
    assert.deepEqual(removed.map(item => item.id).sort(), ['empty', 'missing', 'slides']);
    const data = { items, connections: [
        { id: 'stale-edge', from: { nodeId: 'missing' }, to: { nodeId: 'generator' } },
        { id: 'good-edge', from: { nodeId: 'good' }, to: { nodeId: 'generator' } }
    ], plans: [{ rows: [{ references: [{ itemId: 'missing' }, { filePath: 'E:/media/deck.pptx' }, { itemId: 'good' }] }] }] };
    pruneBoardMedia(data, removed);
    assert.deepEqual(data.items.map(item => item.id), ['good', 'locked', 'external', 'offline', 'generator', 'note']);
    assert.deepEqual(data.connections.map(edge => edge.id), ['good-edge']);
    assert.deepEqual(data.plans[0].rows[0].references, [{ itemId: 'good' }]);
});

test('failed inspections and unavailable preload keep saved media for relinking', async () => {
    const items = [{ id: 'a', filePath: '/media/a.png' }];
    assert.deepEqual(await findUnavailableBoardItems(items, { folders: ['/media'] }), []);
    assert.deepEqual(await findUnavailableBoardItems(items, { folders: ['/media'], inspect: () => { throw new Error('offline'); } }), []);
});
