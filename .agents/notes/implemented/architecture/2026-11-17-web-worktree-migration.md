# Agent Note: Limit worktree migration to Web responsibility

Status: implemented

## Problem

Legacy Git registrations and manifests do not identify their execution backend.
Treating them as migration candidates can change resources whose ownership and
lifecycle are outside the retained Web execution responsibility.

## Decision

Repository preparation selects Web execution records for the current service and
Worker. Their owner and execution identity establish the allowed set. A worktree
binding, or a matching manifest or Git registration after an interrupted creation,
provides the location. Matching schedules and ownership evidence are checked
against that set, and execution identity is rechecked before mutations. Unknown registrations are not migrated or required for format
completion. Web recovery uses its original Web and Controller evidence without
reading the legacy lifecycle journal. This narrows the candidate sources in the
[original migration decision](2026-11-11-worktree-resource-migration.md).

## Alternatives

**Use every Git marker or manifest as an owner.** Neither identifies a Web
execution, so conversion could unlock or alter a resource outside this scope.

**Observe the old backend to classify every registration.** This makes unrelated
Web admission depend on legacy resources and can start an execution backend whose
remaining resources are the user's responsibility.

## Consequences

Unknown resources remain unchanged and do not prevent unrelated Web preparation.
Matching Web resources retain ownership, path and file checks; a conflicting
registration or failed proof still prevents mutation. Format publication does not
claim that unknown resources were migrated or cleaned up.
