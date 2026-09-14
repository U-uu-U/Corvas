import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = Module._load;
const originalDOMMatrix = Object.getOwnPropertyDescriptor(globalThis, 'DOMMatrix');
let CanvasManager;
try {
    Module._load = function (request, ...args) { return request === 'canvas' ? {} : originalLoad.call(this, request, ...args); };
    ({ CanvasManager } = await import('./canvas.js'));
} finally {
    Module._load = originalLoad;
    if (originalDOMMatrix) Object.defineProperty(globalThis, 'DOMMatrix', originalDOMMatrix);
    else delete globalThis.DOMMatrix;
}

function fixture(t) {
    const frames = new Map();
    let frameId = 0;
    const doc = Object.assign(new EventTarget(), { body: { style: { cursor: 'crosshair' } } });
    const win = new EventTarget();
    for (const [name, value] of Object.entries({ document: doc, window: win,
        requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: id => frames.delete(id) })) {
        const original = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name]; });
    }
    const flag = initial => function (value) { if (arguments.length) initial = value; return initial; };
    const lockedHandle = { draggable: flag(false) };
    const group = { draggable: flag(false), getLayer: () => layers[0], find: () => [lockedHandle] };
    const layers = [true, false].map(listening => ({ listening: flag(listening), drawHit: t.mock.fn() }));
    let position = { x: 20, y: -10 };
    const stage = { draggable: flag(true), getLayers: () => layers,
        position: t.mock.fn(value => { if (value) position = { ...value }; return { ...position }; }),
        batchDraw: t.mock.fn(), setPointersPositions: t.mock.fn() };
    const item = { group, loadToken: 9, loaded: false, loadQueued: true };
    const manager = Object.assign(Object.create(CanvasManager.prototype), {
        stage, items: new Map([['media', item]]), _forEachNode: callback => callback(item),
        _syncHoveredMediaItemAtPointer: t.mock.fn(), _scheduleCullCheck: t.mock.fn(), emit: t.mock.fn(),
        _contentLoadQueue: [item], _activeContentLoads: 0, _MAX_CONTENT_LOADS: 4, _loadContent: t.mock.fn()
    });
    const event = (type, x = 100, y = 120) => Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, button: 2 });
    const dispatch = (type, x, y) => doc.dispatchEvent(event(type, x, y));
    return { manager, group, layers, lockedHandle, stage, item, frames, doc, win, event, dispatch,
        tick() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); } };
}

test('pan coalesces duplicate pointer/mouse input and flushes the last position before saving', t => {
    const h = fixture(t);
    h.manager._startCanvasPanFromClientPoint(h.event('mousedown'));
    const initialCalls = h.stage.position.mock.callCount();
    for (let x = 101; x <= 200; x++) { h.dispatch('pointermove', x, 180); h.dispatch('mousemove', x, 180); }
    assert.equal(h.frames.size, 1);
    assert.equal(h.stage.position.mock.callCount(), initialCalls);
    h.tick();
    assert.deepEqual(h.stage.position(), { x: 120, y: 50 });
    h.dispatch('mousemove', 210, 190);
    h.dispatch('pointerup', 220, 200);
    assert.deepEqual(h.stage.position(), { x: 140, y: 70 });
    assert.equal(h.frames.size, 0);
    assert.equal(h.manager.emit.mock.callCount(), 1);
    assert.equal(h.manager._suppressStageMenu, true);
    assert.equal(h.manager._activeCanvasPanStop, null);
    h.dispatch('mousemove', 900, 900);
    assert.deepEqual(h.stage.position(), { x: 140, y: 70 });
});

test('blur restores existing disabled controls and hit layers without discarding media', t => {
    const h = fixture(t);
    h.manager._startCanvasPanFromClientPoint(h.event('mousedown'));
    assert.deepEqual(h.layers.map(layer => layer.listening()), [false, false]);
    h.manager._drainContentLoadQueue();
    assert.equal(h.manager._loadContent.mock.callCount(), 0);
    h.dispatch('pointermove', 50, 70);
    h.win.dispatchEvent(new Event('blur'));
    assert.equal(h.stage.draggable(), true);
    assert.equal(h.group.draggable(), false);
    assert.equal(h.lockedHandle.draggable(), false);
    assert.deepEqual(h.layers.map(layer => layer.listening()), [true, false]);
    assert.equal(h.doc.body.style.cursor, 'crosshair');
    assert.equal(h.item.loadToken, 9);
    assert.equal(h.manager._scheduleCullCheck.mock.callCount(), 1);
    h.manager._drainContentLoadQueue();
    assert.equal(h.manager._loadContent.mock.callCount(), 1);
});

test('a stationary right click still opens the menu and a silent stop cannot save to another project', t => {
    const h = fixture(t);
    h.manager._startCanvasPanFromClientPoint(h.event('mousedown'));
    h.dispatch('mouseup', 100, 120);
    assert.equal(h.manager._suppressStageMenu, false);
    assert.equal(h.manager.emit.mock.callCount(), 0);
    h.manager._startCanvasPanFromClientPoint(h.event('mousedown'));
    h.dispatch('mousemove', 300, 400);
    h.manager._activeCanvasPanStop(null, { commit: false });
    assert.equal(h.frames.size, 0);
    assert.equal(h.manager.emit.mock.callCount(), 0);
});
