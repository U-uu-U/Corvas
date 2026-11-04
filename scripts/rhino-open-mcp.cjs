#!/usr/bin/env node
// Open Rhino, load Grasshopper and start the Cordyceps MCP bridge, then wait until the
// endpoint answers. Reuses electron-main/rhino-desktop.cjs (the same path Corvas uses),
// so the standalone script and the app never drift apart.
//
//   node scripts/rhino-open-mcp.cjs [--rhino "D:\Program Files\Rhino 8\System\Rhino.exe"] [--port 26929]
//
// Without --rhino it reads the path saved by Corvas (data/rhino-workbench.json), then the registry.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RhinoDesktop } = require('../electron-main/rhino-desktop.cjs');

const option = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function probe(endpoint) {
    try {
        const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(3000),
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
        return response.status < 500;
    } catch { return false; }
}

function savedExecutable() {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    try { return JSON.parse(fs.readFileSync(path.join(appData, 'flow-canvas', 'data', 'rhino-workbench.json'), 'utf8')).executablePath; }
    catch { return ''; }
}

(async () => {
    if (process.platform !== 'win32') throw new Error('This script automates Rhino through COM and only runs on Windows.');
    const port = Number(option('--port') || 26929);
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const desktop = new RhinoDesktop();
    if (await probe(endpoint)) { console.log(JSON.stringify({ ok: true, endpoint, status: 'already_running' })); return; }
    let executable = option('--rhino') || savedExecutable();
    if (!desktop.validPath(executable)) {
        const found = (await desktop.discover()) || [];
        executable = found.find(entry => /Rhino 8/.test(entry.name))?.path || found[0]?.path;
    }
    if (!desktop.validPath(executable)) throw new Error('Rhino.exe not found; pass --rhino <path>.');
    // Attach to a visible Rhino if there is one. Launching a second copy would leave the
    // user with two windows and make COM pick an arbitrary instance.
    const running = await desktop.running(executable);
    if (running.length > 1) throw new Error('More than one Rhino is open; close the extra windows first.');
    if (!running.length) {
        console.error(`Starting ${executable}`);
        await desktop.launch(executable, { endpoint });
    }
    // Rhino rejects COM scripts while it initializes. The COM call itself can also fail
    // after the script was already dispatched, so success is judged by the report file
    // and the endpoint, never by the COM return value alone.
    const deadline = Date.now() + 240000;
    let dispatched = false;
    while (Date.now() < deadline) {
        if (await probe(endpoint)) break;
        const report = desktop.bootstrapReport();
        if (report && report.ok === false) throw new Error(`${report.code}: ${String(report.message || '').split('\n').slice(-2).join(' ')}`);
        if (report) dispatched = true;
        if (!dispatched) {
            const state = await desktop.running(executable);
            if (state.length === 1 && state[0].ready) {
                try {
                    const result = await desktop.bootstrap(executable, { endpoint });
                    dispatched = result?.ok === true;
                    if (!dispatched) console.error(`Waiting for Rhino: ${result?.reason || 'not ready'}`);
                } catch (error) {
                    console.error(`Waiting for Rhino: ${(error.stderr || error.message || '').trim().split('\n').slice(-1)[0]}`);
                }
            }
        }
        await sleep(dispatched ? 2000 : 3000);
    }
    if (await probe(endpoint)) {
        const report = desktop.bootstrapReport();
        console.log(JSON.stringify({ ok: true, endpoint, status: report?.status || 'connected', rhinoVersion: report?.rhinoVersion }));
        return;
    }
    throw new Error(dispatched
        ? `Cordyceps did not answer at ${endpoint}; check the Grasshopper solver and the Cordyceps plugin.`
        : 'Rhino did not accept the connection script within 4 minutes.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
