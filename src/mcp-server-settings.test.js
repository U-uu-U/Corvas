import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMcpServerStatus } from './mcp-server-status.js';

test('MCP Server status text covers running, failed and stopped states', () => {
    assert.equal(describeMcpServerStatus(null), '正在读取状态…');
    assert.equal(describeMcpServerStatus({ enabled: true, running: true, url: 'http://127.0.0.1:18765/mcp' }),
        '运行中 · http://127.0.0.1:18765/mcp');
    assert.equal(describeMcpServerStatus({ enabled: true, running: false, error: '端口 18765 已被占用' }),
        '启动失败：端口 18765 已被占用');
    assert.equal(describeMcpServerStatus({ enabled: false, running: false, error: null }), '已关闭，其他 Agent 无法连接');
});
