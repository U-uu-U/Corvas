const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', minLength: 1, maxLength: 160 };
const projectId = { anyOf: [{ type: 'string', minLength: 1, maxLength: 160 }, { type: 'null' }] };
const target = { enum: ['blender', 'rhino'] };
const nodeIds = { type: 'array', items: id, maxItems: 20, uniqueItems: true };
const task = { projectId, taskId: id };
const owner = { ...task, clientId: id };
const conversationUrl = { type: 'string', pattern: '^codex://threads/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' };
const summary = { type: 'string', maxLength: 6000 };
const HANDOFF_INPUT_SCHEMAS = {
    create: object({ projectId, target, instruction: { type: 'string', minLength: 1, maxLength: 12000 }, referenceNodeIds: nodeIds, requestId: id }, ['projectId', 'target', 'instruction', 'referenceNodeIds', 'requestId']),
    list: object({ projectId, target }, ['projectId']),
    get: object(task, ['projectId', 'taskId']),
    cancel: object(task, ['projectId', 'taskId']),
    claim: object({ ...owner, conversationUrl }, ['projectId', 'taskId', 'clientId']),
    update: object({ ...owner, status: { enum: ['running', 'awaiting_user', 'completed', 'failed', 'canceled'] }, summary, resultNodeIds: nodeIds,
        resolvedCalls: { type: 'array', maxItems: 20, uniqueItems: true, items: object({ requestId: id, status: { enum: ['completed', 'failed'] }, summary: { type: 'string', minLength: 1, maxLength: 6000 } }, ['requestId', 'status', 'summary']) }
    }, ['projectId', 'taskId', 'clientId']),
    tools: object(task, ['projectId', 'taskId']),
    call: object({ ...owner, serverId: id, toolName: { type: 'string', minLength: 1, maxLength: 256 }, binding: { type: 'string', minLength: 1, maxLength: 128 }, requestId: id, arguments: { type: 'object' } }, ['projectId', 'taskId', 'clientId', 'serverId', 'toolName', 'binding', 'requestId', 'arguments'])
};
const descriptions = {
    list: 'List persisted external-assistant tasks for an explicit project (null is the root canvas). Tasks do not run the built-in model.',
    get: 'Read the task, original material snapshots, current referenceIssues, owner and call receipts before acting. A missing or changed source must be checked with the user.',
    claim: 'Claim a queued task using a stable external assistant clientId, optionally linking a Codex conversation. Only that owner may update or execute this task; claiming does not run software.',
    update: 'Update a claimed task. Results must already exist as nodes in the original project before resultNodeIds can be attached. Resolve unknown calls only after inspecting actual external software state; provide the observed evidence in resolvedCalls.summary. Never mark a dispatching call resolved. Finished tasks accept only summary and resolvedCalls, without status or resultNodeIds; this never reopens a task.',
    tools: 'Discover the enabled MCP connections matching this task target and their real input schemas and bindings. Does not expose server configuration or credentials. Re-read after connection changes.',
    call: 'Call a discovered external software tool as the task owner without built-in model inference. Use the returned serverId, remote tool name and binding. Reuse requestId and identical inputs after lost responses. Unknown writes block this connection across all tasks and projects, including canceled tasks. Read the blocking task and inspect with read-only tools, then resolve with handoff.update before further writes. Finished tasks with unknown writes still permit read-only inspection.'
};
const HANDOFF_TOOL_DEFINITIONS = Object.entries(descriptions).map(([action, description]) => ({
    name: `flow_canvas.handoff.${action}`, description, inputSchema: HANDOFF_INPUT_SCHEMAS[action],
    ...(['list', 'get', 'tools'].includes(action) ? { annotations: { readOnlyHint: true } } : {})
}));
module.exports = { HANDOFF_TOOL_DEFINITIONS, HANDOFF_INPUT_SCHEMAS };
