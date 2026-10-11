const test = require('node:test');
const assert = require('node:assert/strict');
const { createStartupGate } = require('./startup-gate.cjs');

function fixture() {
    let time = 0, nextId = 0;
    const timers = new Map(), reveals = [];
    const gate = createStartupGate({ now: () => time, onReveal: reason => reveals.push({ time, reason }),
        setTimer: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: time + delay }); return id; },
        clearTimer: id => timers.delete(id) });
    const advance = next => {
        while (true) {
            const due = [...timers].filter(([, timer]) => timer.at <= next).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            time = due[1].at; timers.delete(due[0]); due[1].callback();
        }
        time = next;
    };
    return { gate, timers, reveals, advance };
}

test('a fast startup waits for two visible seconds even if content was ready before the splash', () => {
    const h = fixture(); h.gate.ready(); h.gate.start();
    h.advance(1999); assert.deepEqual(h.reveals, []);
    h.advance(2000); assert.deepEqual(h.reveals, [{ time: 2000, reason: 'ready' }]);
    assert.equal(h.timers.size, 0);
});

test('prepared content after the minimum reveals immediately and only once', () => {
    const h = fixture(); h.gate.start(); h.advance(3500); h.gate.ready();
    h.gate.ready(); h.gate.start(); h.advance(9000);
    assert.deepEqual(h.reveals, [{ time: 3500, reason: 'ready' }]);
});

test('slow or unavailable content cannot hold the splash beyond seven seconds', () => {
    const h = fixture(); h.gate.start(); h.advance(6999);
    assert.deepEqual(h.reveals, []);
    h.gate.start(); h.advance(7000); h.gate.ready();
    assert.deepEqual(h.reveals, [{ time: 7000, reason: 'timeout' }]);
    assert.equal(h.timers.size, 0);
});

test('closing the main window cancels both reveal timers', () => {
    const h = fixture(); h.gate.start(); h.gate.cancel(); h.gate.ready(); h.advance(9000);
    assert.equal(h.timers.size, 0); assert.deepEqual(h.reveals, []);
});
