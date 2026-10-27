# Agent Note: Worker Manual Control and Fresh Terminal Executions

Status: implemented

## Problem

An operator must be able to retry a paused execution or release, transfer and
resume a task without racing the worker's automatic recovery. A process can die
between source cleanup, a remote ownership change and local acknowledgement.
Treating that gap as ordinary recovery can restart an already-cleaned source or
submit the same ownership mutation twice. Source authorization and target
membership also have different meanings, especially when an administrator
manages a claim owned by another user.

The original claim protocol required the source worktree and agent to continue
after release or transfer. That preserved unpublished work while ownership
moved, but conflicts with terminal resource cleanup: done, release and transfer
all end the source execution and delete its worktree. A new execution cannot
require deleted resources or claim the old native conversation as its own.

## Decision

The public `worker retry/release/transfer/resume` commands use the existing
[foreground coordinator](2026-10-27-foreground-worker-runtime.md),
[local records](2026-10-26-worker-local-records.md),
[Git resources](2026-10-26-worker-git-workspaces.md) and
[Herdr adapter](2026-10-26-worker-herdr-adapter.md). The
[worker design](../../../../docs/design/daynight-worker.md#agent-完成与人工操作)
owns their control flow and the
[claim architecture](../../../../docs/design/daynight-worker-claims.md) owns
HTTP fields and transactions. This decision partially supersedes the resource
continuity requirement in the
[claim foundation](2026-10-24-worker-claim-foundation.md); its permissions,
exact-version protection, stopped confirmation and claim fencing remain.

Release/transfer validate current project access and source owner/admin
permission before destructive cleanup. Transfer separately validates the target
member. Current administrator credentials do not rewrite the source record's
immutable original userId, and `/me` alone does not establish admin authority.
The configured service origin must match the source remote scope.

The command atomically saves a concrete control intent in the original task
row before ordinary resource recovery can proceed. It includes the source
claim, exact supplied version and, for transfer, generated target claim/worktree
IDs plus the explicit target descriptor. A foreground singleton polls this same
SQLite and serializes target resource actions. If no foreground controller owns
the instance lock, the command acquires that same lock and runs the same
coordinator for the selected execution. No IPC service, second task registry or
persistent action queue is added.

The source uses the existing terminal cleanup: ask its original agent to release
attributable outside-worktree temporary resources, keep the first deadline of at
most 600000ms across restart, confirm actual stopping, close its workspace and
delete its original worktree. These observations gate the remote write.
Resource-free, proven never-started pending management can record completed
cleanup without becoming active or scanning another claim's canonical path.
Other tasks continue in the same Herdr instance. Cleanup and individual HTTP
requests have separate bounded scopes, so a one-command five-minute budget does
not truncate the ten-minute resource deadline.

Control submission transitions from not-submitted to unknown before HTTP, then
to confirmed or a definite rejection. Unknown outcomes are reconciled with a
targeted task read using the original source claim, exact decision and saved
target claim ID. The same command may perform that read-only reconciliation
while the foreground worker retains resource control. A read of the old value
does not prove that the write was never submitted and does not permit replay. A concrete management read can also prove
that the original claim ended. This explicit result reconciliation does not
weaken automatic cleanup: new automatic absence decisions still require the
complete successful original-user/worker inventory. A different user's inventory
cannot prove that source ownership ended.

A definitely rejected intent can be replaced only by a new explicit decision
whose exact supplied version matches a fresh task observation. The numeric
version may equal the rejected decision when that refusal did not change the
task, including a definite pre-dispatch failure or permission refusal.
Already-completed source cleanup remains complete; the business execution is never rebuilt. An unknown intent cannot be
reset or replaced. Source local done requires both complete cleanup and a
confirmed control outcome. The supplied `--if-version` remains the decision
version rather than being refreshed during cleanup.

The service and typed client reject deprecated `continuityConfirmed` input.
Every acquisition after a historical execution, explicit resume and transfer
uses a fresh claimId and worktreeId; the target agent may differ. Resume still
requires released/todo, matching previousClaimId, readiness and original
owner/admin, while retaining the explicit manual automatic-permission/platform
exception. Transfer still separately checks source authority, current target
membership, automatic permission, platform and dependencies. Release clears the
task's execution interval; transfer preserves in_progress and timing. All old
claim writes remain fenced.

Resume persists its new IDs and effective configuration in the existing
project claimAttempt before its one remote request. Only an actual verified
grant commits pending with the new configuration and authenticated owner;
unknown results retain the same attempt. The receiver of a transfer likewise
discovers an actual granted claim and follows normal pending→active resource
creation. A trace-free new transfer grant honors its explicit remote agent. If the
receiver configuration selects the other type, pending freezes that remote agent
with null model, empty args and the current recovery limit; matching types use
the current effective settings. Existing pending snapshots are unchanged. New
executions use fresh native conversations and wait if the fixed task path is
still occupied. No source snapshot, target pre-registration or
native-history transport is introduced. Ordinary acquisition continues to skip
released tasks and paginate to later candidates.

Retry is a count-bound, atomically granted single recovery permit on the same
valid original-owner claim. It never resets cumulative count, replaces frozen
configuration, bypasses native provenance or authorizes a second agent. Repeated
or concurrent requests do not stack permits. Terminal executions require a new
resume rather than ordinary recovery.

## Alternatives

**Continue the source worktree and native history after terminal operations.**
The foundation initially used this to preserve unpublished results. It requires
source resource retention or cross-machine preparation and conflicts with a
completed source lifecycle. Fresh execution identities let terminal cleanup be
uniform; required business delivery must finish before the source is ended.

**Have each command directly control agents beside a live worker.** This makes
ordinary recovery and destructive source cleanup competing controllers. Saving
the concrete intent in the existing row lets the current singleton own all
resource actions, while the same lock supports a stopped-worker invocation.
A separate control service would add transport and lifecycle state without
changing those ownership requirements.

**Replay a management request after reading the old task value.** The original
write can still commit after that read. Reusing the request or replacing its IDs
would obscure which execution was granted. Persisting unknown before submission
retains that uncertainty and permits positive reconciliation without replay.

**Reset the recovery budget for manual retry.** A reset loses the history of
repeated failure and makes restart or repeated commands an unbounded retry
mechanism. One count-bound permit adds the requested attempt while keeping
fault history and original execution identity.

## Consequences

Source cleanup survives CLI or worker interruption and cannot be undone by
ordinary recovery. Unknown remote outcomes remain explicit, and other tasks
continue through their original controller. Admin management can operate on a
known source scope without pretending that the admin owns the source claim.
Strict deprecated-input rejection makes protocol mismatches visible.

Terminal operations deliberately discard unpublished worktree files and end the
source native execution. Branches and execution history remain, but the worker
does not transport files or reconstruct a source conversation for a target.
Unresolved remote outcomes, missing source scope or unconfirmed process stop can
require operator investigation; those cases retain responsibility rather than
claiming completion.

Normal same-claim crash recovery and Ctrl+C retain original worktree, native
history and configuration. Component, real-service and native management
validation have separate source-bound evidence; command availability does not
establish complete Linux, Windows or macOS Goal acceptance.
