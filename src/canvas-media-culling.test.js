import test from 'node:test';
import assert from 'node:assert/strict';
import { installMediaViewportCulling, isMediaOutsideViewport } from './canvas-media-culling.js';

test('media culling retains viewport edges, labels and unknown dimensions', () => {
    assert.equal(isMediaOutsideViewport([1, 0, 0, 1, -250, 20], 100, 100, 800, 600), true);
    assert.equal(isMediaOutsideViewport([1, 0, 0, 1, -190, 20], 100, 100, 800, 600), false);
    assert.equal(isMediaOutsideViewport([1, 0, 0, 1, 895, 20], 100, 100, 800, 600), false);
    assert.equal(isMediaOutsideViewport([1, 0, 0, 1, 900, 20], 100, 100, 800, 600), true);
    assert.equal(isMediaOutsideViewport([1, 0, 0, 1, 900, 20], NaN, 100, 800, 600), false);
});

test('media bounds include scaling, negative scale and rotation', () => {
    assert.equal(isMediaOutsideViewport([-2, 0, 0, 2, 900, 20], 100, 100, 800, 600), false);
    assert.equal(isMediaOutsideViewport([0, 1, -1, 0, 950, 20], 100, 100, 800, 600), false);
    assert.equal(isMediaOutsideViewport([0.5, 0, 0, 0.5, 950, 20], 100, 100, 800, 600), true);
});

test('offscreen media skips normal scene and hit drawing but not export, caching or dragging', () => {
    let matrix = [1, 0, 0, 1, 1200, 0];
    let dragging = false;
    const calls = [];
    const scene = {}, hit = {};
    const layer = { getCanvas: () => scene, getHitCanvas: () => hit };
    const data = { width: 200, height: 100 };
    const group = {
        getStage: () => ({ width: () => 800, height: () => 600 }),
        getLayer: () => layer, getAbsoluteTransform: () => ({ getMatrix: () => matrix }),
        isDragging: () => dragging, visible: () => true,
        drawScene(...args) { calls.push(['scene', ...args]); return this; },
        drawHit(...args) { calls.push(['hit', ...args]); return this; }
    };
    installMediaViewportCulling(group, data);
    assert.equal(group.drawScene(scene), group);
    group.drawHit(hit);
    assert.equal(calls.length, 0);
    assert.equal(group.visible(), true);
    group.drawScene({ exportCanvas: true });
    group.drawScene(scene, group);
    group.drawHit(hit, group);
    assert.equal(calls.length, 3);
    dragging = true;
    group.drawScene(scene);
    assert.equal(calls.length, 4);
    dragging = false;
    matrix = [1, 0, 0, 1, 100, 100];
    group.drawScene(scene);
    group.drawHit(hit);
    assert.equal(calls.length, 6);
    assert.deepEqual(data, { width: 200, height: 100 });
});
