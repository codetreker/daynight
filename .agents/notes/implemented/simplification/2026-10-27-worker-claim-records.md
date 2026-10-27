# Agent Note: Worker Claim and Native Session Records

Status: implemented

## Problem

A worker must remember which task executions it owns and which native
conversation to resume. Current ownership, Git worktrees and Herdr processes
already have authoritative providers. Copying their detailed lifecycle into a
local record creates multiple representations that must agree before resources
can be reconciled, including after interrupted writes.

The original worker implementation preserved launch receipts, PID provenance,
frozen configuration, cumulative recovery budgets, cleanup deadlines and manual
control intents across restarts. Those guarantees made every resource operation
depend on a large persistent execution model even though the required local
index is project, task, claim, status and native conversation identity.

## Decision

The [worker design](../../../../docs/design/daynight-worker.md) uses exactly
projects(project_id, repo_url, local_path) and tasks(project_id, task_id, claim_id,
status, agent, session_id). Task rows represent actual claims, retain history,
and use pending/active/done. One Project/task can have at most one active claim.
Agent is copilot or codex; session_id is a nullable native conversation ID.

The service supplies complete current own-claim inventory. Git and the private
Herdr instance supply actual resources. Startup resolves configured Projects and
saves their mappings before the first inventory, including with an empty
SQLite database. Only a successfully queried complete Project scope authorizes
absence cleanup. Static resource ownership checks remain with Git and Herdr;
they do not store dynamic execution progress. Existing Git markers have no
workerId, so a Git-only claim requires a matching local row, private Herdr
resource or current own claim before this worker can clean it. Unproven
resources are reported and preserved, including in repositories shared with
another worker.

A live agent is reconnected without replaying its startup prompt. A native
process that needs starting resumes the recorded ID when present. A NULL ID
emits Warning and starts a fresh native conversation in the same task, claim and
worktree, then saves its ID. It has no history-search, pause or approval gate.
Known-ID native resume errors remain visible.

Configuration and recovery/cleanup state are process-local. A restarted process
uses the current applicable model/args for the recorded agent type. Cleanup has
a ten-minute deadline within its current attempt; after interruption, a new
inventory and resource observation starts another attempt. Recovery counts reset
with the process. Logs diagnose operations and never supply a recovery ledger.

Manual commands require a stopped runner and acquire its same instance lock.
They synchronously operate on one claim. Release/transfer stop the agent and
close its workspace, submit the version-bound remote change, then delete the
worktree after ownership is confirmed ended. A refusal retains the checkout for
source recovery. Unknown/interrupted management must be reconciled by the
operator before restarting run; there is no durable control intent.

This decision supersedes the persistent recovery details in the
[local records](../architecture/2026-10-26-worker-local-records.md),
[foreground runtime](../architecture/2026-10-27-foreground-worker-runtime.md),
[Herdr adapter](../architecture/2026-10-26-worker-herdr-adapter.md) and
[manual control](../architecture/2026-10-27-worker-manual-control.md) decisions.
Their original guarantees, implementation constraints and alternatives remain
historical rationale. The [claim foundation](../architecture/2026-10-24-worker-claim-foundation.md),
[current inventory](../architecture/2026-10-26-worker-claim-inventory.md),
[Git ownership](../architecture/2026-10-26-worker-git-workspaces.md) and
[managed execution](../architecture/2026-10-26-managed-task-skill.md) retain their
separate service, resource and instruction responsibilities.

## Alternatives

**Keep only project/task/claim/status.** That is enough for ownership and local
resource status, but loses the native tool type and conversation ID needed when
a process must be resumed. Two explicit columns provide that index.

**Keep the detailed persistent execution model.** Durable receipts and intent
retain stronger cross-restart timing, configuration and uncertainty guarantees.
They also require numerous parsers and transition conditions at every caller.
The worker now rebuilds actions from current facts and accepts the narrower
restart semantics instead.

**Move the removed state into another file or remote ledger.** That keeps the
same synchronization and recovery protocol while hiding it from the table
shape. There is one business index and no alternate execution journal.

## Consequences

SQLite, resource interfaces and recovery share a small business model. The
worker retains static ownership, real stop-before-delete checks, exact remote
versions and errors. A failed or partial read is not an empty resource set.
Old claim resources still block the same task's new execution and retain
capacity until actual cleanup completes.

Restart does not preserve the first cleanup deadline, accumulated recovery
budget, old model/args or an interrupted management decision. NULL native IDs can
lose old conversation continuity, with a Warning and fresh conversation as the
explicit behavior. Management takes the runner offline. The state directory is
for one configured service/account/worker identity; changes require completing
old executions and rebuilding local state.

There is no old-schema migration or automatic deletion. An operator stops the
old worker and removes the old SQLite before new-schema startup, retaining
workerId and native history. Component checks and schema verification do not
establish native conversation or cross-platform whole-Goal acceptance.
