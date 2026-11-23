# Agent Note: Project Goal Cleanup Watermarks

Status: implemented

## Problem

Transferring or deleting a Project removes incident Goal acceptance edges, including edges held by Goals in other Projects. A downstream Goal whose relationship set changed must appear in that Project's Task synchronization window, including when its last edge was removed.

## Decision

The shared Project cleanup DAO advances the independent relationship revision for each distinct actual downstream of a removed edge. Under the [complete Project lock set](2026-11-23-project-goal-cleanup-lock-set.md), it also advances the Task version and update time once for each surviving downstream Goal, using the database clock after acquiring the locks. The transaction locks affected Goal rows before ownership, preserving the Thread Task-to-ownership lock order. A deleted Goal or Goal in a deleted Project is not touched. On source Project deletion, its Goals will no longer be visible and are excluded; source Goals remain eligible on transfer. No actual edge removal changes no watermark. Exhaustion or any failure rolls back the entire cleanup and lifecycle transaction. The [server design](../../../../docs/design/daynight-server.md#项目生命周期中的-goal-边清理) owns the mechanism.

## Alternatives

**Advance only relationship revisions.** Existing Task synchronization would not select the affected Goal after cleanup, so readers could retain stale prerequisites.

**Update downstream metadata after committing Project cleanup.** A failure or intervening ordinary write could advance a downstream watermark before the Goal change becomes visible.

## Consequences

A real cleanup can invalidate stale Task versions in other Projects. Multiple removed edges for one Goal advance its version only once. The existing source epoch behavior and independent relationship revisions are preserved, including revisions for removed or inaccessible downstream Goals.
