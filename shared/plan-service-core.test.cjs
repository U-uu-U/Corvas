const test = require('node:test');
const assert = require('node:assert/strict');
const {
    BOARD_TRANSACTION_MCP_TOOLS,
    MCP_BOARD_TOOLS_VERSION,
    MCP_WORKFLOW_TOOLS_VERSION,
    MCP_HANDOFF_TOOLS_VERSION,
    WORKFLOW_MCP_TOOLS,
    HANDOFF_MCP_TOOLS,
    normalizeMcpConfig
} = require('./plan-service-core.cjs');

test('legacy custom MCP allowlists receive board transaction tools once', () => {
    const migrated = normalizeMcpConfig({
        allowedTools: ['flow_canvas.plan.list']
    });
    assert.equal(migrated.boardToolsVersion, MCP_BOARD_TOOLS_VERSION);
    assert.ok(migrated.allowedTools.includes('flow_canvas.plan.list'));
    BOARD_TRANSACTION_MCP_TOOLS.forEach(toolName => {
        assert.ok(migrated.allowedTools.includes(toolName));
    });
});

test('versioned MCP allowlists preserve later manual tool removals', () => {
    const configured = normalizeMcpConfig({
        boardToolsVersion: MCP_BOARD_TOOLS_VERSION,
        workflowToolsVersion: MCP_WORKFLOW_TOOLS_VERSION,
        handoffToolsVersion: MCP_HANDOFF_TOOLS_VERSION,
        modelConfigToolsVersion: 1,
        allowedTools: ['flow_canvas.board.get_snapshot']
    });
    assert.deepEqual(configured.allowedTools, ['flow_canvas.board.get_snapshot']);
});

test('model CONFIG tools are added once without restoring later manual removals', () => {
    const migrated = normalizeMcpConfig({ allowedTools: [] });
    assert.ok(migrated.allowedTools.includes('flow_canvas.model_config.refresh'));
    const optedOut = normalizeMcpConfig({ ...migrated, allowedTools: ['flow_canvas.model_config.get'] });
    assert.deepEqual(optedOut.allowedTools, ['flow_canvas.model_config.get']);
});

test('workflow tool migration only adds workflow tools to an already versioned allowlist', () => {
    const migrated = normalizeMcpConfig({
        modelConfigToolsVersion: 1,
        boardToolsVersion: MCP_BOARD_TOOLS_VERSION,
        handoffToolsVersion: MCP_HANDOFF_TOOLS_VERSION,
        allowedTools: ['flow_canvas.plan.list', 'flow_canvas.rhino.cleanup']
    });
    assert.equal(migrated.workflowToolsVersion, MCP_WORKFLOW_TOOLS_VERSION);
    assert.deepEqual(migrated.allowedTools, ['flow_canvas.plan.list', ...WORKFLOW_MCP_TOOLS]);
    assert.equal(migrated.allowedTools.includes('flow_canvas.agent.start'), false);
    assert.deepEqual(normalizeMcpConfig(migrated), migrated);
});

test('current workflow config keeps all explicitly disabled tools disabled', () => {
    const configured = normalizeMcpConfig({
        modelConfigToolsVersion: 1,
        boardToolsVersion: MCP_BOARD_TOOLS_VERSION,
        workflowToolsVersion: MCP_WORKFLOW_TOOLS_VERSION,
        handoffToolsVersion: MCP_HANDOFF_TOOLS_VERSION,
        allowedTools: []
    });
    assert.deepEqual(configured.allowedTools, []);
});

test('older workflow config adds new tools without restoring disabled tools', () => {
    const configured = normalizeMcpConfig({
        modelConfigToolsVersion: 1,
        boardToolsVersion: MCP_BOARD_TOOLS_VERSION,
        workflowToolsVersion: 1,
        handoffToolsVersion: MCP_HANDOFF_TOOLS_VERSION,
        allowedTools: ['flow_canvas.workflow.status', 'flow_canvas.plan.list']
    });
    assert.equal(configured.workflowToolsVersion, 3);
    assert.deepEqual(configured.allowedTools, ['flow_canvas.workflow.status', 'flow_canvas.plan.list',
        'flow_canvas.workflow.confirm', 'flow_canvas.workflow.configure']);
    assert.deepEqual(normalizeMcpConfig(configured), configured);
    assert.deepEqual(normalizeMcpConfig({ ...configured, allowedTools: [] }).allowedTools, []);
});

test('external handoff tools migrate once without re-enabling other removed tools', () => {
    const migrated = normalizeMcpConfig({ modelConfigToolsVersion: 1, boardToolsVersion: MCP_BOARD_TOOLS_VERSION,
        workflowToolsVersion: MCP_WORKFLOW_TOOLS_VERSION, allowedTools: ['flow_canvas.health'] });
    assert.deepEqual(migrated.allowedTools, ['flow_canvas.health', ...HANDOFF_MCP_TOOLS]);
    assert.equal(migrated.handoffToolsVersion, MCP_HANDOFF_TOOLS_VERSION);
    assert.deepEqual(normalizeMcpConfig({ ...migrated, allowedTools: ['flow_canvas.health'] }).allowedTools,
        ['flow_canvas.health']);
});
