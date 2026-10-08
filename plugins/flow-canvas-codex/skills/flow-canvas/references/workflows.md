# Reusable Corvas Workflows

Use these tools for the saved Hunyuan-to-Rhino workflow. Corvas executes the fixed steps and persists job state locally; the external Agent selects inputs, submits work, and reports progress. Do not wrap this workflow in `flow_canvas.agent.start` or rebuild its stages with arbitrary Rhino scripts.

## Discover and choose inputs

1. Call `flow_canvas.health` and `flow_canvas.context.get_active_group` to identify the running Corvas instance and project. Keep the chosen `projectId`, including `null` for the default project, for the entire job.
2. Call `flow_canvas.workflow.list` and `flow_canvas.workflow.get` with the returned `workflowId`. The initial built-in definition is `hunyuan-rhino-cleanup`, version `1`. Read its current input schema and steps instead of assuming all templates accept the same parameters.
3. Call `flow_canvas.workflow.sources` with optional `accountId`. It returns account metadata, model sources, and per-account errors. Sources have `accountId`, `generationId`, `worksId`, `label`, and `origin` (`current` or `saved`). Use returned IDs, not IDs inferred from screenshots or download URLs.
4. For "the current model", prefer the matching account's `current` source. If several open accounts have different current models and the user's intent does not identify one, ask which model/account to use. A saved source can be used for a model from earlier work. If no matching source is available, explain the returned error or ask the user to open that model in the Corvas Hunyuan window, then refresh sources.

The workflow downloads an already-generated model, connects Rhino/Cordyceps, imports the model, and runs inspect, clean, quad, and validate stages. It preserves the source model. This template does not create a new Hunyuan generation and does not run image/video generation. The optional `targetQuads` parameter is an integer from `500` to `100000`; omit it unless the user specifies a target or the task requires a deliberate override.

## Start a new job

The user's explicit request to import and clean up the selected model authorizes this submission. A source lookup alone does not authorize a run. Keep one stable `requestId` for this intended submission before calling the tool:

```json
{
  "workflowId": "hunyuan-rhino-cleanup",
  "version": 1,
  "projectId": null,
  "requestId": "import-selected-model-2026-09-20-01",
  "source": {
    "accountId": "<accountId from sources>",
    "generationId": "<generationId from sources>"
  }
}
```

Call `flow_canvas.workflow.run` with these arguments. Use the actual project ID when operating in a named project. `requestId` is unique within that project; a UUID or another stable unique string is suitable. Optional parameters use `"parameters": { "targetQuads": 20000 }`.

The response is a job snapshot: `id` (use this as `jobId`), `status`, workflow identity/version, stage states, outputs, report directory, and recovery guidance such as `canResume`, `nextAction`, and `pollAfterMs`. It may also include `runId` for the desktop task card. `runId` is not the identifier for the workflow recovery tools.

Submission returns before the long Rhino operation finishes. Save or retain the `jobId`, `projectId`, and `requestId` in the conversation. Query `flow_canvas.workflow.status` with `{ "projectId": ..., "jobId": ... }`, following `pollAfterMs` and `nextAction`. Report successful completion only after the job state and validation outputs confirm it.

## Disconnects and recovery

- If the submission response is lost, use `flow_canvas.workflow.history` in the same project to locate the job. Retrying `workflow.run` with the exact same `requestId` and arguments is also idempotent. Do not invent a new key to recover an unknown submission.
- Reusing a `requestId` with different inputs or parameters returns `IDEMPOTENCY_CONFLICT`. Check the existing job; create a new request only when the user intends a separate run.
- To continue earlier work, call `flow_canvas.workflow.history` with `projectId` and optional `offset`/`limit` (defaults `0`/`20`), then `workflow.status` for the selected `jobId`. Do not substitute the currently active project for the job's original project.
- When `canResume` is true and the requested continuation is appropriate, call `flow_canvas.workflow.resume` with the original `projectId` and `jobId`. This queues the existing job and reuses completed stages. Follow `nextAction` if Rhino, a document, or another prerequisite needs attention.
- If a Rhino command's result is still unknown, query status and follow recovery guidance. Do not rerun the command, create a second job, or delete checkpoints to force progress.
- An MCP client disconnect does not erase the local job. Corvas must remain running for its executor to run; after Corvas restarts, inspect saved state and resume as directed instead of claiming automatic continuation.

Concurrent submissions for the same model and parameters may return the same active job. A new `requestId` after the earlier run has finished starts a separate pass. An explicit request to redo work and a request to recover interrupted work are different operations.

## Cancel and boundaries

Call `flow_canvas.workflow.cancel` with the original `projectId` and `jobId` when the user asks to stop. Cancellation prevents later stages; it cannot undo an import or interrupt a Rhino command already executing. Read the resulting status before describing what stopped.

Only the built-in versioned workflow is exposed here. These tools do not accept arbitrary script uploads or a general workflow DSL. Existing canvas Skill templates and `flow_canvas.skill.*` are a separate capability; they should not be presented as executable Rhino workflow definitions.

The workflow and job records belong to the local Corvas data directory, not to this conversation or MCP client. Another client connected to the same Corvas instance and project can discover them. A different computer or Corvas data directory does not automatically share those records.
