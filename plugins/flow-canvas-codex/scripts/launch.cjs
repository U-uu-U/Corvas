/* global __dirname, process */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function findMcpEntry() {
    const pluginRoot = path.resolve(__dirname, '..');
    const repositoryRoot = path.resolve(pluginRoot, '..', '..');
    const candidates = [
        process.env.FLOW_CANVAS_MCP_ENTRY,
        process.env.FLOW_CANVAS_ROOT && path.join(process.env.FLOW_CANVAS_ROOT, 'mcp', 'flow-canvas-mcp.mjs'),
        path.join(repositoryRoot, 'mcp', 'flow-canvas-mcp.mjs')
    ].filter(Boolean).map(value => path.resolve(value));

    return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

const entry = findMcpEntry();
if (!entry) {
    process.stderr.write(
        'Flow Canvas MCP entry was not found. Set FLOW_CANVAS_ROOT to the Flow Canvas source directory.\n'
    );
    process.exitCode = 1;
} else {
    const child = spawn(process.execPath, [entry], {
        cwd: path.dirname(path.dirname(entry)),
        env: process.env,
        stdio: 'inherit'
    });

    const forwardSignal = signal => {
        if (!child.killed) child.kill(signal);
    };
    process.once('SIGINT', () => forwardSignal('SIGINT'));
    process.once('SIGTERM', () => forwardSignal('SIGTERM'));
    child.once('error', error => {
        process.stderr.write(`Unable to start Flow Canvas MCP: ${error.message}\n`);
        process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
    });
}
