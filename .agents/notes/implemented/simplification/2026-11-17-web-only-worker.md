# Agent Note: Web-only Worker execution

Status: implemented

## Problem

Maintaining two Worker execution paths duplicates ownership, configuration and
cleanup rules. The two paths also require a strict shared wire shape that older
clients cannot consume after the retired fields are removed. Existing tasks and
recordings still require their original identities and historical read formats.

## Decision

Worker admission and execution use Web and Controller only. Configuration,
reports and detail exchange the two-tool shape under tool-path protocol 2;
ordinary Task and historical reads retain their separate boundaries. Existing
Herdr tasks and resources are not migrated, observed or cleaned up. Web task,
claim and journal identity fences cleanup and worktree migration. Frozen SQLite
and Web journal representations remain readable.

The configuration checkpoint retains raw desired values and revision separately
from validated application state. Its schema 6 uses a `format: "web"` marker:
the existing mainline had already used schema 6 for an earlier shape, so the
marker distinguishes that strictly decoded legacy shape without rewriting a
user's desired target. Web history can be revalidated; unsupported targets remain
visible and cannot authorize new work. Atomic persistence precedes readiness.

This decision replaces the execution-mode and negotiation portions of the
[cloud mode](../architecture/2026-11-10-worker-cloud-control-mode.md),
[tool-path configuration](../architecture/2026-11-11-worker-tool-path-configuration.md),
[worktree migration](../architecture/2026-11-11-worktree-resource-migration.md),
and [configuration recovery](../architecture/2026-11-12-worker-configuration-storage-recovery.md)
decisions. Their original rationale remains useful for the features retained
outside the retired path. The current Worker contract and mechanism belong to
[requirements](../../../../docs/spec/daynight-worker.md) and
[design](../../../../docs/design/daynight-worker.md).

## Alternatives

**Keep separate execution backends.** This retains mode-specific recovery,
configuration proof and cleanup even though only Web execution is required.

**Switch each component independently with compatibility projections.** Old
strict clients require the removed fields and new consumers require the new
shape; temporary adapters add a second contract and can hide incompatible
versions. The server, CLI and embedded Web instead change together.

**Automatically convert or clean up old tasks.** Existing ownership and process
state cannot be inferred safely from a historical record. Operators retain
responsibility for those resources and recordings remain readable.

## Consequences

New clients require a service supporting the new tool-path protocol, and older
clients must upgrade. Unsupported desired values require an explicit user save;
they are not silently transformed. Old execution records remain on disk without
being treated as Web ownership. Live terminal UI and server removal are separate
changes; the history read boundary remains independent of Worker execution.
