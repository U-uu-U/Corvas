---
name: hunyuan-rhino-workflow
description: Use Corvas MCP to import an existing Hunyuan model into Rhino, run the saved mesh cleanup workflow, and find or resume its persisted jobs across conversations. Use for this fixed workflow, not arbitrary Rhino scripting or new model generation.
---

# Hunyuan to Rhino Workflow

Corvas owns the executable workflow and its local job records. The external Agent selects inputs, submits work, and reports progress through `flow_canvas.workflow.*`. Use these tools directly; do not call `flow_canvas.agent.start` or reconstruct the workflow with ad hoc Rhino scripts.

Keep workflow decisions in the external Codex conversation or MCP client. Corvas no longer injects workflow panels into the canvas or Hunyuan webpage. Do not redirect the user to the Corvas built-in Agent sidebar for confirmation or recovery.

## Connection and reuse

Corvas must be running with its local MCP bridge enabled. Rhino and the Corvas Rhino/Cordyceps connection must be configured; the selected Hunyuan account must be logged in and its model already generated.

An MCP connection exposes tools and their schemas, not this Skill. A client must load or install this Skill separately if it supports Skills. Clients without it can still discover the workflow through `workflow.list/get` and the tool descriptions.

Connecting another conversation or MCP client to the same Corvas instance and original project allows reuse of its workflow and job records. Records do not automatically transfer to another computer or Corvas data directory. A reusable workflow definition and an execution job are different: reuse the template for new input, or resume the original job for interrupted work.

## Select a workflow and model

1. Call `flow_canvas.health` and `flow_canvas.context.get_active_group`. Keep the chosen `projectId` for the entire job; `null` means the root canvas.
2. Call `flow_canvas.workflow.list`, then `flow_canvas.workflow.get` with `workflowId`. The built-in definition is `hunyuan-rhino-cleanup`, version `1`. Read its current schema and steps before submitting.
3. Call `flow_canvas.workflow.sources`, optionally filtered by `accountId`. Use the returned `accountId` and `generationId`. Sources include `label`, `worksId`, and `origin` (`current` or `saved`); account errors explain unavailable sources. Do not invent IDs or supply a download URL.
4. For the current model, select the matching account's `current` source. If multiple accounts have different current models and the request does not identify one, clarify which account/model. If unavailable, ask the user to open that model in the Corvas Hunyuan window and refresh sources. A matching `saved` source can be reused for an earlier model.

The template downloads an existing model, connects Rhino, imports it, and runs `inspect`, `clean`, `quad`, and `validate`. It preserves the source model and uses fixed scripts without built-in Agent inference or new paid model generation. Optional `parameters.targetQuads` is an integer from `500` to `100000`; omit it unless a deliberate target is needed.

## Submit and monitor

An explicit request to import and clean up the chosen model authorizes submission. Discovery alone does not. Call `flow_canvas.workflow.run` with:

- `workflowId`: `hunyuan-rhino-cleanup`.
- `version`: the supported version returned by `workflow.get` (currently `1`).
- `projectId`: the selected project ID or `null`.
- `requestId`: a stable unique string of up to 160 characters, chosen before submission.
- `source`: `{ accountId, generationId }` from `workflow.sources`.
- `parameters`: optionally `{ targetQuads: 20000 }`.

The response immediately returns a job snapshot. Its `id` is the `jobId` for subsequent calls. Keep `jobId`, `projectId`, and `requestId`; an optional `runId` belongs to the desktop task card and is not the workflow recovery ID.

Poll `flow_canvas.workflow.status` with `{ projectId, jobId }`, following `pollAfterMs` and `nextAction`. Use returned `stages`, `outputs`, `reportDirectory`, and `canResume` to explain progress or recovery. Report success only when job status and validation outputs confirm completion.

## Decisions in Codex

- Read `availableActions` and `nextAction` from status. When user input is needed, use Codex's native question/choice UI if available; otherwise ask a concise question in the conversation. Do not ask again for work already authorized in this conversation.
- For `nextAction: confirm`, the manual-mode job is waiting for authorization. Once authorized, call `flow_canvas.workflow.confirm` with its original `{ projectId, jobId }`. Use `workflow.cancel` when the user declines. Do not poll indefinitely or create a new run to confirm the existing job.
- For `nextAction: resolve_blocker`, inspect the job identified by `blockedBy.jobId` and `blockedBy.projectId`. Explain why it blocks the queue and offer the actions its status permits. Resume or cancel that job only within the user's intent; removing a popup does not authorize either action.
- Present model/account choice and optional mesh density in Codex when the requested input is ambiguous. Continue directly when the user has already selected them.
- These are tool responses handled during an active Codex task. Connecting MCP alone does not push a native Codex dialog or wake an idle conversation; do not claim proactive delivery is installed.

## Recover without duplicating work

- After a lost submission response, find the job with `flow_canvas.workflow.history` in the original project. Retrying `workflow.run` with the exact same `requestId` and arguments is idempotent. Do not use a new key to recover an unknown submission.
- The same `requestId` with changed inputs returns `IDEMPOTENCY_CONFLICT`. Inspect the existing job; use a new key only for an intentionally separate run.
- `flow_canvas.workflow.history` takes `projectId` and optional `offset`/`limit` (defaults `0`/`20`, maximum limit `100`). Use it across conversations, then call `workflow.status`. Never substitute the currently active project for the job's original project.
- To continue requested work when `canResume` is true, call `flow_canvas.workflow.resume` with `{ projectId, jobId }`. It immediately queues that original job, checks saved results, and reuses completed stages. Resolve prerequisites indicated by `nextAction` first.
- If a Rhino operation's result is unknown, follow status and recovery guidance. Do not rerun its command, create another job, or delete checkpoints to force progress.
- Concurrent requests for the same model and parameters may share an active job. A new `requestId` after completion creates a separate pass. Changing input is a new run; recovering interrupted work is a resume.

An MCP client disconnect does not stop the Corvas executor or erase the job. Corvas itself must remain running to schedule steps. If Corvas exits, an already-issued Rhino command may continue; after restarting Corvas, query persisted state and resume as directed rather than assuming automatic continuation.

## Cancel and scope

For a user-requested stop, call `flow_canvas.workflow.cancel` with `{ projectId, jobId }`. It stops later stages but cannot undo imported objects or force an already-running Rhino command to stop. Check returned status before reporting what was canceled.

This interface currently exposes only the built-in versioned template. It does not upload arbitrary scripts or define a general workflow DSL. Existing canvas templates under `flow_canvas.skill.*` are separate from these executable Rhino workflows.
