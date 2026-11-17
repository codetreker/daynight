# Agent Note: Coordinate only Web executions

Status: implemented

## Problem

Worker coordination previously combined Herdr and Web ownership, capacity and
cleanup. Historical Herdr claims and resources cannot be treated as Web
executions, and the remaining Web path must preserve its own identity and stop
proofs without taking responsibility for those historical resources.

## Decision

The coordinator inventories and manages only Web claims. New local claims and
reservations explicitly identify Web; existing rows are retained but are excluded
from Web execution and cleanup queries. A cleanup schedule is used only with
matching Web execution identity. Git registrations and manifests do not by
themselves prove Web ownership; actual identity and path conflicts remain errors.
The original Web stop, capacity, archive and worktree responsibilities continue.
Existing Herdr claims, processes and resources remain the user's responsibility.

This narrows the earlier [capacity decision](../architecture/2026-11-11-worker-execution-capacity.md)
and complements the [Web worktree migration decision](../architecture/2026-11-17-web-worktree-migration.md).
The [Herdr claim reservation decision](../architecture/2026-11-12-herdr-claim-tool-reservations.md)
records the original shared-daemon motivation; its Herdr coordination no longer
applies to the Worker scheduler.

## Alternatives

**Retain both coordination paths.** This would continue automatic recovery and
cleanup of historical Herdr executions, contrary to their user-owned lifecycle.

**Treat every Git manifest as Web ownership.** A manifest lacks execution-mode
proof and could cause an unrelated historical resource to be stopped or removed.

## Consequences

Old records are not rewritten or automatically retired. A real identity or path
collision remains visible and must be resolved at its source. Web executions
continue to use their existing journal, stop proofs and independent archive
maintenance; a stopped execution can release capacity while file work remains.
