# Agent Note: Discover and clear task pauses in the Web workspace

Status: implemented

## Problem

A task may retain an active execution while its periodic continuation is paused.
Task status, automatic-execution permission and the worker's execution phase do
not identify that pause. Operators need to discover the affected task before
opening its session and clear the pause without changing its execution identity.
An operator action must also retain the existing protection against concurrent,
stale and uncertain task writes.

## Decision

The Web workspace consumes the existing boolean `properties.paused`. Only true
produces an amber pause icon and a localized Paused label. Absent and explicit
false remain distinct stored values, while both hide that presentation. A
present non-boolean value is a protocol error at detail and summary admission.
The [runtime pause decision](2026-11-02-task-paused-worker-pings.md) continues to
own continuation suppression and the agent's intervention workflow.

Full task summaries retain the property. Their local projection derives a
`pausedTaskIds` set alongside the graph; `TaskProjection` and `GraphSnapshot`
carry it without adding properties or a pause field to the graph wire model.
The project task context supplies the same set to standalone rows, chain
members and graph nodes. Project and task-list counts use the full project;
chain counts use the complete ordinary component, excluding external
prerequisites. Pagination, assignee filters and a bounded visible graph do not
change these totals. Counts remain independent of task status and permission.
The overview count uses existing navigation to reach an affected task.

The common detail heading displays the pause and an Unpause button across
dialog, page, fullscreen and reading-tab variants. The operation sends one
ordinary task PATCH with the reviewed exact version and
`properties:{paused:false}`. It shares the task session's mutation owner,
identity and history admission, pending guard and GET reconciliation. A
successful response preserves all other properties, status, timing, permission,
assignee, platform, dependencies and claim. The confirmed complete detail then
updates its cache and matching project presentation. Conflicts require a fresh
decision; unknown writes are read back without replay or causal attribution.

The automatic-execution permission switch keeps its acquisition meaning.
Unpause is available during `in_progress` under ordinary task-write admission;
it does not launch or restart an agent, change worker phase, or authorize a
worker recovery retry. Failure and reconciliation use the existing floating
feedback layer, preserving the visible pause and a reachable recovery action.
[Web requirements](../../../../docs/spec/daynight-web.md#暂停展示与解除) and
[design](../../../../docs/design/daynight-web.md#暂停展示与解除) own the interface.

## Alternatives

**Use the automatic-execution switch for resume.** That field permits automatic
acquisition and deliberately cannot change during an in-progress task. Reusing
it would conflate permission with continuation and hide the needed operation
for the principal paused case.

**Carry full properties through graph nodes.** Graph consumers intentionally
use a compact model. A separately derived pause set provides the required
presentation while leaving graph transport, indexing and layout responsibilities
unchanged.

**Use the individual property endpoint.** It returns a PropertyResource rather
than a complete TaskDetail. The ordinary PATCH already merges the intended
property and fits complete-response validation and cache installation without
a second mutation coordinator or an extra detail read after confirmation.

## Consequences

Pause discovery is available from the project overview, task lists, dependency
graph and detail. Counts do not become another task status or redefine existing
statistics. The browser adds no server endpoint, database field, migration or
CLI command, and the pause property remains the only source of truth.

Clearing the flag makes the existing worker continuation policy applicable; it
does not retract previously sent input or prove that a provider has resumed.
Runtime recovery failures and their explicit retry authorization remain separate.
Coverage must exercise true, false and absent values, invalid types, complete
projection scopes, version fencing, preserved materials, uncertain outcomes,
navigation, keyboard access and narrow-screen presentation.
