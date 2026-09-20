const object = (properties = {}, required = []) => ({
    type: 'object', properties, required, additionalProperties: false
});
const string = { type: 'string', minLength: 1 };
const identifier = { type: 'string', pattern: '^[a-f0-9]{32}$' };
const projectId = { type: ['string', 'null'] };
const source = object({ accountId: string, generationId: identifier }, ['accountId', 'generationId']);
const parameters = object({ targetQuads: { type: 'integer', minimum: 500, maximum: 100000 } });
const jobInput = object({ projectId, jobId: identifier }, ['projectId', 'jobId']);
const runInput = object({
    workflowId: string,
    version: { type: 'integer', minimum: 1 },
    projectId,
    requestId: { type: 'string', minLength: 1, maxLength: 160 },
    source,
    parameters
}, ['workflowId', 'version', 'projectId', 'requestId', 'source']);

const HUNYUAN_RHINO_WORKFLOW = {
    id: 'hunyuan-rhino-cleanup',
    version: 1,
    name: 'Hunyuan model to Rhino cleanup',
    description: 'Download an existing Hunyuan model, import it into Rhino, and run the bundled cleanup workflow. The original model is preserved. Uses fixed local scripts without model-provider inference or new paid model generation.',
    inputSchema: object({ source, parameters }, ['source']),
    steps: [
        { id: 'download', title: 'Download the model' },
        { id: 'connect', title: 'Connect to Rhino' },
        { id: 'import', title: 'Import the model' },
        { id: 'inspect', title: 'Inspect imported objects' },
        { id: 'clean', title: 'Clean a model copy' },
        { id: 'quad', title: 'Create a quad mesh' },
        { id: 'validate', title: 'Validate and record results' }
    ]
};

const WORKFLOW_TOOL_DEFINITIONS = [
    {
        name: 'flow_canvas.workflow.list',
        description: 'List reusable, versioned Corvas workflows. Jobs use the persistent task executor without built-in model inference.',
        inputSchema: object(),
        annotations: { readOnlyHint: true }
    },
    {
        name: 'flow_canvas.workflow.get',
        description: 'Read the selected workflow version, required inputs, fixed steps, and parameters before starting a job.',
        inputSchema: object({ workflowId: string }, ['workflowId']),
        annotations: { readOnlyHint: true }
    },
    {
        name: 'flow_canvas.workflow.sources',
        description: 'List available Hunyuan model references, optionally filtered by account. Select the returned accountId and generationId; do not invent IDs or supply download URLs. This may refresh saved model references and does not modify Rhino.',
        inputSchema: object({ accountId: string }),
        annotations: { readOnlyHint: true }
    },
    {
        name: 'flow_canvas.workflow.run',
        description: 'Start a persisted workflow job and immediately return its job ID. Pass the exact workflow version and explicit projectId (null for the root canvas). Use a stable requestId for the same request; retry with the same inputs and requestId after a lost response to avoid duplicate submission. This imports an existing model and does not generate a new paid model.',
        inputSchema: runInput
    },
    {
        name: 'flow_canvas.workflow.status',
        description: 'Read a persisted workflow job, step progress, results, and recovery information. Poll this after run or resume, including after the MCP client reconnects.',
        inputSchema: jobInput,
        annotations: { readOnlyHint: true }
    },
    {
        name: 'flow_canvas.workflow.history',
        description: 'List persisted workflow jobs for an explicit project, with pagination. Use this to find a job ID after reconnecting instead of starting another job.',
        inputSchema: object({
            projectId,
            offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100 }
        }, ['projectId']),
        annotations: { readOnlyHint: true }
    },
    {
        name: 'flow_canvas.workflow.resume',
        description: 'Continue the original workflow job using saved checkpoints and the same job ID. Completed work is checked and reused; no built-in Agent inference is started.',
        inputSchema: jobInput
    },
    {
        name: 'flow_canvas.workflow.cancel',
        description: 'Request cancellation of a workflow job. A Rhino operation already running may finish before cancellation takes effect; imported objects and completed results are preserved.',
        inputSchema: jobInput
    }
];

module.exports = { WORKFLOW_TOOL_DEFINITIONS, HUNYUAN_RHINO_WORKFLOW };
