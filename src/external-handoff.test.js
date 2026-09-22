import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffController, handoffStatusLabel } from './external-handoff.js';
import { AgentSidebar } from './agent-sidebar.js';

test('handoff retry preserves request identity and blocks duplicate clicks', async () => {
    const calls = [];
    let release;
    let latest;
    const pending = new Promise(resolve => { release = resolve; });
    const controller = createHandoffController({
        api: { list: async () => ({ tasks: [{ id: 'task', projectId: 'project', status: 'queued' }] }) },
        target: 'blender', getProjectId: () => 'project', newRequestId: () => 'request',
        onHandoff: async (...args) => { calls.push(args); if (calls.length === 1) { await pending; throw new Error('Response lost'); } },
        onChange: state => { latest = state; }
    });
    const first = controller.create('Inspect scene');
    await controller.create('Inspect scene');
    assert.equal(calls.length, 1);
    release(); await first;
    assert.equal(latest.message, 'Response lost');
    await controller.create('Inspect scene');
    assert.deepEqual(calls, [['Inspect scene', 'request'], ['Inspect scene', 'request']]);
    assert.equal(latest.tasks[0].status, 'queued');
    assert.equal(latest.busy, false);
    assert.equal(latest.message, '交接任务已创建');
});

test('stale list responses cannot overwrite tasks from the current project', async () => {
    const pending = [];
    let projectId = 'first';
    let latest;
    const controller = createHandoffController({
        api: { list: request => new Promise(resolve => { pending.push({ request, resolve }); }) },
        target: 'rhino', getProjectId: () => projectId, onHandoff() {}, onChange: state => { latest = state; }
    });
    const first = controller.refresh();
    projectId = 'second';
    const second = controller.refresh();
    pending[1].resolve({ tasks: [{ id: 'second-task', projectId: 'second' }] });
    await second;
    pending[0].resolve({ tasks: [{ id: 'first-task', projectId: 'first' }] });
    await first;
    assert.equal(latest.tasks[0].id, 'second-task');
    assert.deepEqual(pending.map(item => item.request), [
        { projectId: 'first', target: 'rhino' }, { projectId: 'second', target: 'rhino' }
    ]);
});

test('copy and cancellation address the saved task project even after switching projects', async () => {
    const calls = [];
    let latest;
    const controller = createHandoffController({ api: {
        copy: async request => { calls.push(['copy', request]); },
        cancel: async request => { calls.push(['cancel', request]); },
        list: async request => { calls.push(['list', request]); return { tasks: [] }; }
    }, target: 'blender', getProjectId: () => 'current', onHandoff() {}, onChange: state => { latest = state; } });
    const task = { id: 'task', projectId: 'original', status: 'queued' };
    await controller.copy(task);
    assert.equal(latest.message, '交接指令已复制');
    assert.equal(task.status, 'queued');
    await controller.cancel(task);
    assert.deepEqual(calls, [
        ['copy', { projectId: 'original', taskId: 'task' }],
        ['cancel', { projectId: 'original', taskId: 'task' }],
        ['list', { projectId: 'current', target: 'blender' }]
    ]);
});

test('opening a claimed conversation passes only the original task identity and preserves its state', async () => {
    const calls = [];
    let latest;
    const controller = createHandoffController({ api: {
        open: async request => { calls.push(request); }
    }, target: 'blender', getProjectId: () => 'current', onHandoff() {}, onChange: state => { latest = state; } });
    const task = { id: 'task', projectId: 'original', status: 'awaiting_user',
        owner: { conversationUrl: 'codex://threads/019e96d7-2695-7611-a3e7-a457304c4db5' } };
    await controller.open(task);
    assert.deepEqual(calls, [{ projectId: 'original', taskId: 'task' }]);
    assert.equal(task.status, 'awaiting_user');
    assert.equal(latest.busy, false);
    assert.equal(latest.message, '');
});

test('sidebar freezes ordered source IDs before flush and reuses them after an uncertain response', async t => {
    const previousWindow = globalThis.window;
    t.after(() => { globalThis.window = previousWindow; });
    const requests = [];
    let projectId = 'original';
    let selection = [{ id: 'second' }, { id: 'first' }, { id: 'second' }, { id: '' }];
    let flushes = 0;
    globalThis.window = { flowCanvas: { handoff: { create: async request => {
        requests.push(structuredClone(request));
        if (requests.length === 1) throw new Error('Response lost');
        return { id: 'task', ...request };
    } } } };
    const sidebar = Object.assign(Object.create(AgentSidebar.prototype), { options: {
        getActiveProjectId: () => projectId, getSelectedCanvasEntries: () => selection,
        flushBoard: async () => { flushes++; projectId = 'other'; selection = [{ id: 'new' }]; return true; }
    } });
    await assert.rejects(sidebar._createExternalHandoff('blender', 'Inspect', 'request'), /Response lost/);
    await sidebar._createExternalHandoff('blender', 'Inspect', 'request');
    assert.equal(flushes, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(requests[0], { projectId: 'original', target: 'blender', instruction: 'Inspect',
        referenceNodeIds: ['second', 'first'], requestId: 'request' });
    assert.equal(sidebar.externalHandoffRequests.size, 0);
});

test('sidebar blocks handoff creation when canvas flush fails', async t => {
    const previousWindow = globalThis.window;
    t.after(() => { globalThis.window = previousWindow; });
    globalThis.window = { flowCanvas: { handoff: { create: () => assert.fail('must not submit') } } };
    const sidebar = Object.assign(Object.create(AgentSidebar.prototype), { options: { flushBoard: async () => false } });
    await assert.rejects(sidebar._createExternalHandoff('rhino', 'Inspect', 'request'), /保存冲突/);
});

test('internal Agent no longer selects external software skills or changes external workflow mode', async t => {
    const previousWindow = globalThis.window;
    t.after(() => { globalThis.window = previousWindow; });
    let configured;
    globalThis.window = { flowCanvas: { hunyuan: { configureWorkflow: async context => { configured = context; } } } };
    const sidebar = Object.assign(Object.create(AgentSidebar.prototype), {
        customAgentSkills: [], globalConfig: { agentSkillIds: ['rhino-model-editing', 'blender-animation', 'board-planning'], agentExecutionMode: 'auto' },
        hunyuanWorkflowReady: true, activeRuntimeProjectId: 'project', activeConversationId: 'conversation'
    });
    assert.deepEqual(sidebar._selectedAgentSkillIds(), ['board-planning']);
    sidebar._syncHunyuanWorkflowContext();
    assert.deepEqual(configured, { projectId: 'project', conversationId: 'conversation' });
    for (const [status, expected] of Object.entries({ queued: '待 Codex 接手', running: '处理中', awaiting_user: '等待用户',
        completed: '完成', failed: '失败', canceled: '取消' })) assert.equal(handoffStatusLabel(status), expected);
});
