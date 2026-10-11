#!/usr/bin/env node

import { createCorvasMcp, McpError } from './flow-canvas-tools.mjs';

const { tools, callTool } = createCorvasMcp();

let inputBuffer = Buffer.alloc(0);
let stdinEnded = false;
const pendingMessages = new Set();

process.stdin.on('data', chunk => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    for (const { message, framing } of readMessages()) {
        const pending = handleMessage(message, framing).catch(error => {
            if (message?.id !== undefined) {
                send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: {
                        code: error.code || -32603,
                        message: error.message,
                        ...(error.data === undefined ? {} : { data: error.data })
                    }
                }, framing);
            }
        }).finally(() => {
            pendingMessages.delete(pending);
            maybeExitAfterStdinEnd();
        });
        pendingMessages.add(pending);
    }
});

process.stdin.on('end', () => {
    stdinEnded = true;
    maybeExitAfterStdinEnd();
});

function readMessages() {
    const messages = [];
    while (inputBuffer.length > 0) {
        if (/^Content-Length:/i.test(inputBuffer.toString('ascii', 0, 15))) {
            const headerEnd = inputBuffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) return messages;
            const header = inputBuffer.slice(0, headerEnd).toString('utf8');
            const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
            if (!lengthMatch) {
                inputBuffer = Buffer.alloc(0);
                return messages;
            }
            const length = Number(lengthMatch[1]);
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + length;
            if (inputBuffer.length < bodyEnd) return messages;
            const raw = inputBuffer.slice(bodyStart, bodyEnd).toString('utf8');
            inputBuffer = inputBuffer.slice(bodyEnd);
            messages.push({ message: JSON.parse(raw), framing: 'content-length' });
            continue;
        }

        const newline = inputBuffer.indexOf('\n');
        if (newline < 0) return messages;
        const line = inputBuffer.slice(0, newline).toString('utf8').trim();
        inputBuffer = inputBuffer.slice(newline + 1);
        if (line) messages.push({ message: JSON.parse(line), framing: 'jsonl' });
    }
    return messages;
}

async function handleMessage(message, framing = 'jsonl') {
    if (!message || typeof message !== 'object') return;
    const { id, method, params = {} } = message;

    if (id === undefined) return;

    try {
        if (method === 'initialize') {
            sendResult(id, {
                protocolVersion: params.protocolVersion || '2024-11-05',
                capabilities: {
                    tools: {}
                },
                serverInfo: {
                    name: 'flow-canvas-mcp',
                    version: '0.1.0'
                }
            }, framing);
            return;
        }

        if (method === 'ping') {
            sendResult(id, {}, framing);
            return;
        }

        if (method === 'tools/list') {
            sendResult(id, { tools }, framing);
            return;
        }

        if (method === 'tools/call') {
            sendResult(id, await callTool(params.name, params.arguments), framing);
            return;
        }

        throw new McpError(-32601, `Method not found: ${method}`);
    } catch (error) {
        send({
            jsonrpc: '2.0',
            id,
            error: {
                code: error.code || -32603,
                message: error.message,
                ...(error.data === undefined ? {} : { data: error.data })
            }
        }, framing);
    }
}

function sendResult(id, result, framing = 'jsonl') {
    send({ jsonrpc: '2.0', id, result }, framing);
}

function send(payload, framing = 'jsonl') {
    const json = JSON.stringify(payload);
    if (framing === 'content-length') {
        const body = Buffer.from(json, 'utf8');
        process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
        process.stdout.write(body);
    } else process.stdout.write(`${json}\n`);
}

function maybeExitAfterStdinEnd() {
    if (!stdinEnded || pendingMessages.size > 0) return;
    process.exitCode = 0;
}
