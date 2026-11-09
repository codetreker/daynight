# Agent Note: Preserve Task Deletion During Step Success Admission

Status: implemented

## Problem

A valid Step write can be confirmed while its asynchronous collection admission is still pending. A concurrent recovery read can then establish Task deletion or retire that opening. Discarding the stale collection alone does not stop the write's continuation from refreshing the project and starting another parent GET, replacing the deletion explanation with loading or an error.

## Decision

The successful Steps continuation re-enters the shared mutation stage after collection admission. It waits for same-identity verification, then checks disposal, deletion, detail admission, the current operation, and the source-specific generation and read ticket before scheduling project and parent refreshes. Summary tickets retain cache and project-revision qualification. Direct tickets retain persistent history, opening and request qualification; they do not acquire a synthetic cache generation.

The [original Step status decision](../../archived/architecture/2026-11-04-task-steps-web-status.md) established the shared write and reconciliation owner. The [direct observation decision](../architecture/2026-11-06-task-direct-observation.md) supplies the newer source-specific qualification. The [Steps design](../../../../docs/design/daynight-task-steps.md) owns the current lifecycle contract.

## Alternatives

**Rely on collection admission alone.** Its generation fence discards stale arrays but returns normally. The caller can still start a parent read after deletion.

**Compare every ticket's cache generation.** Direct observations use history and opening fences instead. A cache-only comparison suppresses the required healthy direct refresh.

**Replay the write after verification.** The service may already have committed it. Only the read-only admission and follow-up stages may wait for identity verification; the submitted write remains single-shot.

## Consequences

Deletion remains terminal against a late successful Step continuation, while healthy summary and direct openings still complete their own version convergence. Current owners handle restoration and later operations. Deterministic session tests control real source-specific IndexedDB qualification, recovery responses and authentication pause; they do not establish production browser or live service acceptance.
