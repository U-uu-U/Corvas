---
name: flow-canvas
description: Use the Corvas Flow Canvas MCP server to inspect and edit a local creative canvas, run authorized media generation, and reuse or resume saved Hunyuan-to-Rhino model cleanup workflows.
---

# Flow Canvas

Flow Canvas must be running before using its tools. Start by calling `flow_canvas.health`, then read the active project context and the relevant board snapshot before making decisions.

For importing a Hunyuan model into Rhino and cleaning it up, read [references/workflows.md](references/workflows.md). Use `flow_canvas.workflow.*` to run the saved workflow directly; this does not require the built-in conversational Agent. A board snapshot is needed only if the task also uses canvas content.

## Operating rules

- Treat the active project, folder group, conversation, node IDs, item IDs, and revisions as authoritative references.
- For canvas edits, use `flow_canvas.board.get_snapshot`, then `flow_canvas.board.transaction.preview`, then `flow_canvas.board.transaction.apply` with the snapshot revision as `baseRevision`.
- Include a stable `idempotencyKey` for every applied transaction. On `REVISION_CONFLICT`, read a fresh snapshot and re-plan instead of overwriting the user's changes.
- Use `flow_canvas.item.*` and plan tools to inspect existing context before creating duplicates.
- Keep source references in their original order and preserve parent-to-child connections when producing a new version.
- Before image or video generation, summarize the intended model, references, output count, and paid operation. Do not start a paid generation merely to inspect capabilities.
- Use task query and recovery tools when a submission response is interrupted. Do not blindly resubmit a task whose remote result is unknown.
- Report the actual task and artifact state; do not claim a generation succeeded based only on an assistant response.
- Distinguish a reusable workflow definition from a running job. Use the original `jobId` and `projectId` to continue a job; use a new `requestId` for an intentionally new run. Reconnecting an MCP client does not itself restart work.

## Common workflows

### Inspect a project

1. Call `flow_canvas.health`.
2. Call `flow_canvas.context.get_active_group`.
3. Call `flow_canvas.board.get_snapshot` with the narrowest useful scope.
4. Use `flow_canvas.item.get` or `flow_canvas.plan.get` for details.

### Edit the board

Read a snapshot, construct the smallest transaction, preview it, and apply it only when validation succeeds. Use the returned undo token if the user asks to undo that Agent edit.

### Generate media

Resolve the model and its supported capabilities from Flow Canvas configuration. Reuse selected or connected references instead of asking the user to upload the same files again. Keep the generated result connected to its source node or task record.

### Reuse a saved Rhino workflow

Discover definitions with `flow_canvas.workflow.list` and `flow_canvas.workflow.get`, resolve the requested model with `flow_canvas.workflow.sources`, then submit through `flow_canvas.workflow.run`. To continue earlier work, find it with `flow_canvas.workflow.history` and read `flow_canvas.workflow.status` before calling `flow_canvas.workflow.resume`. The [workflow reference](references/workflows.md) defines submission keys, recovery, and cancellation boundaries.
