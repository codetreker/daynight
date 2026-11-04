# Agent Note: Worker Cleanup from Authoritative Resource State

Status: implemented

## Problem

A cleanup can remove a resource before its caller receives success or before the
Worker stores a result. Conversely, a saved completion flag can outlive a
resource that reappears. Requiring a recorded sequence of successful operations
then leaves already removed resources blocking capacity, or skips real remaining
resources. One unattributed task directory can also prevent discovery of healthy
resources when directory presence is treated as proof of a managed worktree.

## Decision

The [Worker design](../../../../docs/design/daynight-worker.md#状态来源与清理判定)
reconciles desired resource absence with observations from each resource owner.
Daynight supplies current claim ownership; Herdr supplies current terminal
resources; the original Controller journal supplies Web operation receipts and
generation identity; the OS supplies original process-instance liveness; Git and
the filesystem supply worktree and endpoint presence; the service supplies archive
readiness. Identity and ownership remain necessary to authorize a mutation.
Saved identity never establishes liveness or absence.

An ended local claim with no globally observed resources still enters the same
serialized cleanup jobs and backoff as known resource owners. Its target carries
claim identity and an optional actual worktree ID. Fresh Herdr, Web or Git
observations can supply a full owner; otherwise the job confirms execution
absence and checks only an empty unregistered reservation. A recognized same-task
resource belonging to another claim is left untouched while the absent old claim
can settle. No missing identity is fabricated.

Worker cleanup records retain responsibility, intent, the first deadline and
retry policy. They do not retain notification submission or resource-completion
flags. Worker format 7 removes notified/submitted from cleanup_schedules; Web
format 2 removes duplicated cleanup input/result and stopped/closed/deleted
fields while preserving kind, startedAt, deadline and the original operation
identity. Both are explicit SQL upgrades. Each cleanup attempt returns a fresh,
nonpersistent completion result used by the coordinator. Cleanup scheduling is
persisted only for a complete resource owner; an identity-only target retains its
unfinished index row and process-local backoff, then rediscovers resources after
restart. A done row does not
suppress resource observation or authorize skipping remaining cleanup.

Web queries the original Controller operation by its stable cleanupOperationId
rather than mirroring its receipt into another Worker state machine. Original
process proofs are checked against the OS on every cleanup, then endpoint absence
is reconciled. Terminal cleanup verifies archive readiness before Git removal;
shutdown still stops and closes only, preserving worktrees and archive sources.

Herdr has a PTY submission acknowledgement but no queryable per-input operation
identity. Each bounded cleanup call sends one advisory notification and reads
fresh snapshots until idle permits stopping, resources disappear, or the first
deadline expires. A failed or uncertain send is not replayed within that call.
An interrupted call or restarted Worker may notify the still-live original agent
again. The deadline never restarts, and no new agent is launched for cleanup.
Idle determines when to begin stopping; fresh workspace and OS stop observations
establish resource absence after stopAndClose. The separate
[operation-budget decision](../bug-fix/2026-11-04-worker-cleanup-operation-budget.md)
limits each cleanup observation or mutation to five minutes, including nested
requests. That per-operation budget does not replace the ten-minute advisory
deadline or establish cleanup completion.

Git cleanup observes the worktree directory and its owned administrative
registration separately. A missing directory already meets its target; a remaining
owned registration can be removed independently. Preparation can also remove an empty unregistered
reservation before creating the intended checkout. Empty pre-add reservations and
empty leaves left by final .git unlink are removed using checked nonrecursive
rmdir. This grants no authority to remove unattributed contents. Discovery lists
recognized registrations instead of failing the whole snapshot on a stray plain
directory. Targeted cleanup still exposes nonempty or conflicting resource errors.
A lost removal response is reconciled by reading the actual remaining resources.

This decision partially supersedes the notification ledger in the
[cleanup retry decision](../bug-fix/2026-11-04-worker-cleanup-retry.md),
the ambiguous-empty-leaf retention rule in the
[Git workspace decision](2026-10-26-worker-git-workspaces.md), and the completed
Web evidence reuse in the
[read-only cleanup decision](../bug-fix/2026-11-04-worker-readonly-directory-cleanup.md).
The [claim record decision](../simplification/2026-10-27-worker-claim-records.md),
[Web evidence decision](2026-10-28-web-execution-evidence.md),
[agent patrol decision](../bug-fix/2026-10-27-worker-agent-patrol.md) and
[direct shutdown decision](../bug-fix/2026-10-28-worker-direct-shutdown.md)
retain their separate ownership, business-input, recovery and exit responsibilities.
Their original timing and no-replay trade-offs remain historical rationale.

## Alternatives

**Keep completion flags and repair the missing-directory case.** This fixes one
symptom while a stale agentStopped, backendResourcesClosed or worktreeDeleted
flag still suppresses authoritative observations. Every interrupted operation
would continue to require another ledger transition and recovery case.

**Persist the Herdr notification receipt elsewhere.** A second file, label or
local table still cannot query whether the native model consumed a PTY input.
It relocates the operation ledger without providing a resource source of truth.
The advisory repetition boundary is explicit; Web retains stronger reconciliation
because its Controller owns queryable operation identities.

**Delete every unregistered reserved directory recursively.** A deterministic
path is not ownership proof and can hold unrelated data. Nonrecursive rmdir
resolves empty residue without granting deletion of unknown contents.

**Keep an empty pointerless leaf for manual resolution.** This protected against
mistaking a reused inode for the original directory, but retained capacity after
a completed content deletion. Removing only an observed empty directory needs no
inference about the origin of its contents and keeps nonempty paths protected.

## Consequences

Repeated cleanup and restart converge from actual remaining resources. Completed
records and lost acknowledgements cannot by themselves keep absent resources
alive or hide present ones. Static identities, permission failures and incomplete
observations remain visible; the Worker does not turn an unreadable source into
an empty resource set. Real remaining resources and archive duties retain capacity
and the same-task barrier until their targets are observed.

Herdr advisory notification is not exactly once across interruption. This is the
cost of avoiding a Worker-owned operation history without a native queryable
receipt. Stronger notification reconciliation would require a Herdr protocol
capability, not another Worker completion flag. The existing per-task serialization,
instance lock and stopped-writer requirement continue to bound filesystem cleanup;
path-based unlink/rmdir does not provide hostile-writer isolation.
