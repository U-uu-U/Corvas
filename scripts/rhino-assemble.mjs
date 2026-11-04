#!/usr/bin/env node
// Assemble cleaned Hunyuan part meshes in Rhino from a JSON spec, over the Rhino MCP
// (Cordyceps rhino_scene script). The script never edits the source meshes; it writes
// transformed copies to spec.layer and replaces earlier copies on that layer.
//
//   node scripts/rhino-assemble.mjs scripts/rhino/drone-assembly.json [--endpoint http://127.0.0.1:26929/mcp]
//
// Spec: { layer, parts: [{ name, job, size, rotate?: [[axis, deg]], instances: [{ name, position, anchor?, rotateZ?, mirrorX? }] }] }
// `job` is the Corvas workflow jobId; the part mesh is the one on layer "Corvas quad <job[:16]>".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const specPath = args.find(arg => !arg.startsWith('--') && arg !== flag('--endpoint'));
const endpoint = flag('--endpoint') || 'http://127.0.0.1:26929/mcp';
if (!specPath) { console.error('Usage: node scripts/rhino-assemble.mjs <spec.json>'); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

async function call(name, input) {
    const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(300000),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) });
    const text = await response.text();
    const line = text.split('\n').find(entry => entry.startsWith('data:'));
    const message = JSON.parse(line ? line.slice(5) : text);
    if (message.error) throw new Error(JSON.stringify(message.error));
    return (message.result?.content || []).map(part => part.text || '').join('\n');
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-assemble-'));
fs.copyFileSync(path.join(here, 'rhino', 'assemble-parts.py'), path.join(work, 'assemble-parts.py'));
fs.writeFileSync(path.join(work, 'spec.json'), JSON.stringify(spec));
const report = path.join(work, 'report.json');
try {
    const reply = await call('rhino_scene', { action: 'script', cmd: `_-RunPythonScript "${path.join(work, 'assemble-parts.py')}"` });
    const deadline = Date.now() + 120000;
    while (!fs.existsSync(report) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
    if (!fs.existsSync(report)) throw new Error(`Rhino did not report back: ${reply.slice(0, 300)}`);
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
} finally {
    // Rhino may still hold the script file briefly; a leftover temp folder is harmless.
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* ignore */ }
}
