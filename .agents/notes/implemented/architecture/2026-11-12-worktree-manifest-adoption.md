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
Backend obligations and local cleanup settle before metadata retirement. A
metadata-only retry does not restore execution capacity or the same-task barrier.
The [migration decision](2026-11-11-worktree-resource-migration.md) describes
source validation and recovery, while the [Worker design](../../../../docs/design/daynight-worker.md#git-工作区与资源身份) owns the current mechanisms.

## Alternatives

**Retain Git locks and persistent physical identities.** These tie ownership to
registration and historical filesystem identifiers and require every consumer to
maintain the same drift and lock protocol.

**Move existing checkouts to worktreeId paths.** Frozen Controller and Herdr cwd
would no longer identify their original execution.

## Consequences

Old Workers cannot manage the converted format; recovery requires stopping the
manager and explicit data recovery. Unknown sources and conflicting bindings
retain the affected repository gate. Transient directory checks still protect an
individual operation, but the mechanism does not isolate malicious concurrent
filesystem writers. Git local-closed does not prove that descendants detached
from stdio have stopped or cannot write after handover. The earlier
[physical-identity decision](../bug-fix/2026-11-10-worker-recovery-evidence.md)
retains its historical rationale.
