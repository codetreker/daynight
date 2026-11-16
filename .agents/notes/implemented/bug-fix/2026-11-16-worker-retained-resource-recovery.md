# Agent Note: Diagnose and recover retained Worker resources

Status: implemented

## Problem

A Worker can retain six execution reservations while running one task. Git-only
owners without independent execution records consume capacity, but a one-time
local warning does not explain this persistent blockage in current monitoring.
Completed execution journals also fall outside ordinary unfinished-execution
reconciliation, leaving no explicit safe path for their surviving worktrees.

## Decision

Resource observation reports a typed, claim-scoped ownership failure for every
unproven owner and includes the scanned project-relative worktree binding.
Repeated observations retain the failure identity; successful complete observation
is required to clear it. Restart reconstructs the failures from retained resources.
Capacity includes an optional complete partition of occupied identities into
active-task and retained-resource reservations before details are bounded or
permission-filtered. Neither category claims that a native process is running.

The explicit recovery command verifies a retained completed Web journal against
the original principal, Worker, terminal claim, Git binding, stopped Controller
and native execution, and confirmed archive representation. Default invocation
previews; confirmation repeats the checks and removes only the clean, preserved
worktree without force. Every preservation read explicitly binds the validated
gitfile and original worktree, so a worktree-specific `core.worktree` cannot
redirect checks to a clean directory while ignored files remain in the original.
Deletion likewise binds the original common Git directory. Index hints that can hide modified files are rejected:
Git status and non-forced worktree removal both trust those hints. Recovery does
not clear the user's flags to manufacture a clean result. The original branch,
journals and archive remain. The
[Worker specification](../../../../docs/spec/daynight-worker.md#w-10agent-完成与资源清理)
and [design](../../../../docs/design/daynight-worker.md#遗留资源核验) own the
command's guarantees and refusal conditions.

This complements the [execution-capacity decision](../architecture/2026-11-11-worker-execution-capacity.md)
and the [resource evidence decision](2026-11-10-worker-recovery-evidence.md):
confirmed stop may release an execution slot independently of archive retention,
but a static marker cannot establish that stop or authorize deleting a worktree.

## Alternatives

**Exclude unknown owners or raise concurrency.** This hides outstanding process
responsibility and admits more work without proving the retained executions stopped.

**Treat Task completion or an absent Session as stop evidence.** Neither identifies
the original local execution or preserves its archive. Recovery rejects missing
original journals rather than reconstructing a successful stop.

**Reuse ordinary execution retry.** Retry requires an unfinished original claim
and addresses native execution. It cannot safely reclaim a terminal, completed
Web execution's surviving worktree. Unfinished journals already have automatic
reconciliation, and Herdr retains its existing resource handling.

**Reopen completed cleanup and delete on a later poll.** This would change durable
execution state and separate the operator's preservation check from deletion.
The explicit command verifies and acts while holding the Worker lock instead.

## Consequences

Unknown ownership remains visible and capacity-constraining until sufficient
evidence is restored or safe recovery is confirmed. Losing every original journal
still requires recovering a backup; no force-adoption flag bypasses that limit.
The command refuses dirty and ignored content and requires an observed remote
reference containing HEAD, which can require the operator to preserve files and
commits first. Non-forced Git deletion and immediate binding rechecks protect
ordinary concurrent edits; they do not create an atomic filesystem snapshot
against malicious same-user replacement. Older Workers omit capacity breakdown,
which remains unknown rather than being inferred from a filtered detail list.
