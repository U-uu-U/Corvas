const MIN_DISPLAY_MS = 2000;
const MAX_DISPLAY_MS = 7000;

function createStartupGate({ onReveal, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let startedAt = null;
    let ready = false;
    let finished = false;
    let minimumTimer;
    let maximumTimer;
    const clear = () => { clearTimer(minimumTimer); clearTimer(maximumTimer); };
    const reveal = reason => {
        if (finished) return;
        finished = true;
        clear();
        onReveal(reason);
    };
    return {
        start() {
            if (startedAt !== null || finished) return;
            startedAt = now();
            minimumTimer = setTimer(() => { if (ready) reveal('ready'); }, MIN_DISPLAY_MS);
            maximumTimer = setTimer(() => reveal('timeout'), MAX_DISPLAY_MS);
        },
        ready() {
            ready = true;
            if (startedAt !== null && now() - startedAt >= MIN_DISPLAY_MS) reveal('ready');
        },
        cancel() { finished = true; clear(); }
    };
}

module.exports = { createStartupGate, MIN_DISPLAY_MS, MAX_DISPLAY_MS };
