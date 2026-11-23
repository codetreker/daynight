# Agent Note: Goal Relationship Task Watermark

Status: implemented

## Problem

A Goal's acceptance prerequisites can change while its Task version and update time remain unchanged. A consumer using the existing Task synchronization watermark cannot identify that the Goal's relationship set changed.

## Decision

A real direct relationship edit advances the downstream Goal's Task version and update time in the same Project and Team graph transaction as the relationship revision and edges. The database supplies the time after the Project lock. A no-op preserves both revisions and the timestamp; exhaustion or any failure rolls back the transaction. The independent relationship revision and its original authorization and graph rules remain in the [relationship transaction decision](2026-11-19-goal-relation-service.md). The [relationship design](../../../../docs/design/goal-dependencies.md) describes the current write mechanism.

## Alternatives

**Use only the independent relationship revision.** Task synchronization cannot discover a changed Goal through its existing update window without a separate relationship polling mechanism.

**Replace the relationship revision with the Task version.** Relationship clients need their existing precise concurrency contract independently of unrelated Goal metadata edits.

## Consequences

A changed relationship also invalidates stale Task metadata versions. Existing synchronization records do not yet expose Goal edges; the versioned write supplies the watermark needed by a later reader. [Project cleanup](2026-11-23-project-goal-cleanup-watermark.md) likewise advances the watermark of each live affected downstream Goal.
