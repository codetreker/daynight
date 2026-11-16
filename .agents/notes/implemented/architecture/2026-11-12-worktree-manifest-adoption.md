# Agent Note: Adopt worktree manifests for Worker resources

Status: implemented

## Problem

Git lock markers and persistent physical identities coupled ownership to a
particular registration and task directory. Partial conversion or independent
path guesses could lose the original owner, move a frozen execution cwd, or let
cleanup affect another claim.

## Decision

Repository preparation converts legacy sources before admitting file operations.
The Worker locates resources through durable manifests, preserves migrated cwd,
uses worktreeId directories for new claims and keeps taskId branches. Allocation
reserves a directory, publishes its manifest and then performs unlocked Git add.
A manifest alone does not authorize deleting nonempty unregistered content.
An active claim may rebuild a missing checkout at its original binding from the
retained branch without proof that execution never started. This does not bypass
the original Git mutation's local closure or backend-specific execution and
recovery admission.
Backend obligations and local cleanup settle before metadata retirement. A
metadata-only retry does not restore execution capacity or the same-task barrier.
Legacy Herdr can settle an orphan manifest from complete current observations
after in-process operations join; loss of an in-memory receipt does not require
inventing historical stop evidence. Shared-daemon resource observation runs under
the instance mutex without spawning. An empty observation requires no current or
pending instance owner, no execution responsibilities, absent configuration,
session directory and both endpoints, and confirmed stopped native mappings.
Otherwise the adapter reconnects to the original instance and reads its resources;
missing configuration alone cannot establish absence. Unknown ownership and
observation errors retain the repository gate. This permits a Web Worker that has
never started Herdr to retire orphan metadata without requiring a Herdr daemon.
An independently confirmed successor binding
permits retiring only the old metadata without inspecting the successor cwd.
Standalone release retires its manifest before returning successfully. The
[cleanup outcome decision](2026-11-12-worktree-cleanup-outcome.md) defines fresh
resource observation and error propagation before retirement. Web and
durable Herdr retain their own stop and archive obligations.
The [migration decision](2026-11-11-worktree-resource-migration.md) describes
source validation and recovery, while the [Worker design](../../../../docs/design/daynight-worker.md#git-工作区与资源身份) owns the current mechanisms.

## Alternatives

**Retain Git locks and persistent physical identities.** These tie ownership to
registration and historical filesystem identifiers and require every consumer to
maintain the same drift and lock protocol.

**Move existing checkouts to worktreeId paths.** Frozen Controller and Herdr cwd
would no longer identify their original execution.

**Require historical first-start proof before rebuilding a missing checkout.**
Legacy Herdr cannot recover that proof for an unknown claim result or an older
execution, so valid claims could remain unable to start after a restart.

**Require historical legacy stop receipts for empty-resource reconciliation.**
Those receipts are process-local; treating their loss as an enduring obligation
prevents retirement even when current ownership and resource observations are
complete. This does not replace Web or durable Herdr evidence.

## Consequences

Old Workers cannot manage the converted format; recovery requires stopping the
manager and explicit data recovery. Unreadable resource sources and conflicting
bindings retain the affected repository gate. Unassociated namespace directories
remain outside migration and do not block preparation, as defined by the
[namespace decision](../simplification/2026-11-13-ignore-unassociated-worktree-directories.md). Transient directory checks still protect an
individual operation, but the mechanism does not isolate malicious concurrent
filesystem writers. Rebuilding a missing checkout preserves committed branch
history but cannot recover uncommitted content lost with the directory. Git
local-closed does not prove that descendants detached
from stdio have stopped or cannot write after handover. The earlier
[physical-identity decision](../bug-fix/2026-11-10-worker-recovery-evidence.md)
retains its historical rationale.
