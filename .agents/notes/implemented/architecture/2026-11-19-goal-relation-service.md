# Agent Note: Authorized Goal Relationship Transactions

Status: implemented

## Problem

Goal acceptance relationships can cross Projects and survive changes in caller visibility. Editing must use a real authorization point, preserve completed-Goal invariants, prevent cycles across concurrent Project writes, and let an editor remove an inaccessible prerequisite without revealing its identity. Relationship reads must not expose hidden successors through page boundaries.

## Decision

A dedicated Goal relationship service coordinates repeatable-read projections and Project-bound edits. Core owns the final graph rules; the Store supplies a single post-lock SQL admission snapshot containing source authorization, candidate authorization, endpoint facts and current Team ownership. All edits take the local Project lock followed by its owner Team graph lock, shared with [Goal lifecycle protection](2026-11-19-goal-dependency-lifecycle.md) and [Project cleanup](2026-11-19-project-goal-dependency-cleanup.md). Remote Project and Task rows are neither locked nor updated.

Relationships retain independent opaque edge IDs and persistent revisions. Exact revision comparison precedes no-op detection. Real changes advance once; empty sets retain their revision. Read projections redact inaccessible prerequisite targets and filter inaccessible successors before LIMIT. The [relationship design](../../../../docs/design/goal-dependencies.md) owns the mechanism and service guarantees.

## Alternatives

**Authorize the source and candidates in separate statements.** A concurrent revocation followed by a Project move can combine an earlier source grant with later same-Team ownership even though no valid authorization point existed.

**Reuse the Task metadata version.** Project cleanup would need to lock and modify remote Task rows. Independent revisions preserve cleanup lock order and detect an edge set returning to its former contents.

**Filter a bounded successor page in application code.** Hidden rows would alter page sizes or cursor boundaries, leaking their presence and skipping readable successors.

## Consequences

Every graph writer must honor the shared Team lock order. Relationship edits can wait behind lifecycle operations, so cancellation and bounded transaction cleanup remain required. Independent reads refresh permissions on every page, and hidden prerequisite removal uses only the editor's opaque edge reference. Existing Task DTOs and ordinary dependency scheduling remain independent. Unknown commit outcomes require observation and a new decision rather than automatic replay.
