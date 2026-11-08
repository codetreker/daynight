# Agent Note: Status integration test entry

Status: implemented

## Problem

Status and attachment continuity tests need the real project, detail session
and cache, but entering every child task through the graph also mounts ReactFlow
for scenarios that do not assert graph presentation or interaction.

## Decision

The two attachment refresh cases and the uncertain-status reconciliation case
open the child through the real expanded chain row. That row and the graph node
invoke the same project task-opening callback and detail session. The tests keep
their task identities, asynchronous reads and writes, attachment nodes, focus and
no-replay assertions. Graph fullscreen, zoom, inspection, refresh failure and
obsolete-response cases retain their graph entry. App route isolation retains
the real App routes. The [Web validation guide](../../../../packages/daynight-web/README.md#development)
owns the test commands and coverage gate.

## Alternatives

**Enter every scenario through the graph.** This exercises graph presentation
even when the assertion concerns the shared detail session or an attachment,
adding unrelated mounting and interaction cost.

**Mount an isolated detail component.** This would omit the real project entry,
summary admission and shared cache that these integration scenarios rely on.

## Consequences

The selected cases retain the actual project and detail ownership without
requiring graph presentation. They do not prove graph entry; dedicated graph
scenarios continue to exercise that path. Case improvements do not establish
whole-file, Job or workflow savings under concurrent execution.
