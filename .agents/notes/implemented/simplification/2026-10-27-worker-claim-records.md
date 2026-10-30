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

The [worker design](../../../../docs/design/daynight-worker.md) uses
projects(project_id, repo_url, local_path) and tasks(project_id, task_id, claim_id,
status, agent, session_id, agent_control_mode). Task rows represent actual claims, retain history,
and use pending/active/done. One Project/task can have at most one active claim.
Agent is copilot, codex or claude; session_id is a nullable native conversation ID.
The [Web execution evidence decision](../architecture/2026-10-28-web-execution-evidence.md)
adds claim-frozen mode routing and a separate Web-only evidence store. The
resource-derived recovery and process-local execution rules below apply to Herdr;
they do not replace the Controller journal or authorize uncertain Web replay.
The [SQLite format migration decision](../architecture/2026-10-30-cli-sqlite-migrations.md)
versions this same index independently without adding business columns or another
recovery ledger.

The service supplies complete current own-claim inventory. Git and the private
Herdr instance supply actual resources. Startup resolves configured Projects and
saves their mappings before the first inventory, including with an empty
SQLite database. Only a successfully queried complete Project scope authorizes
absence cleanup. Static resource ownership checks remain with Git and Herdr;
they do not store dynamic execution progress. The [workspace naming and identity
decision](../architecture/2026-10-28-worker-workspace-names.md) keeps the shared
resource coordinates to project/task/claim/worktree and uses titles only for
Herdr display. The [migration removal decision](2026-10-28-remove-worker-workspace-migration.md)
removes the separate workspace-format maintenance state; startup and management
use the normal claim/session index and resource observations. Existing Git markers have no
workerId, so a Git-only claim requires a matching local row, private Herdr
resource or current own claim before this worker can clean it. Unproven
resources are reported and preserved, including in repositories shared with
another worker. Before cleanup or exit removes a verified private Herdr label,
a missing local claim is recorded as pending with its observed native agent and
any live session ID. The [direct shutdown decision](../bug-fix/2026-10-28-worker-direct-shutdown.md)
owns this use of the existing index to preserve orphan cleanup responsibility
after workspace closure. An unavailable original agent type remains a visible
error that preserves the workspace; no configuration-derived type is invented.

Herdr snapshots from polling drive scheduling and capacity only. Startup or
recovery reads Herdr again inside the task's serialized operation before choosing
reconnection, workspace recreation or native launch. An inactive pane can acquire
a live agent while an action waits behind another operation; the earlier polling
snapshot cannot authorize replacing that process. Fresh observation supplies the
needed fact without another state field or persistent receipt.

A live agent is reconnected without replaying its startup prompt. A native
process that needs starting resumes the recorded ID when present. A NULL ID
starts a fresh native conversation in the same task, claim and worktree, then
saves its ID. It has no history-search, pause or approval gate. This decision
originally classified that event as Warning to expose the fresh-conversation
choice during recovery. The [fresh-session logging decision](../bug-fix/2026-10-28-worker-fresh-session-info.md)
uses `info` because NULL is also the normal state of a new claim. Known-ID native
resume errors remain visible. A non-NULL saved ID is also validated against every
reported native reference before binding it or sending
deferred input. A mismatch remains an error and retains the original ID, so a
later live reconnect cannot turn a failed resume into another conversation.
A genuine live observation may fill a NULL row; inactive retained references
are still excluded.

An existing inactive workspace is stopped/closed and recreated with the native
launch environment before starting a fresh or resumed process. Herdr 0.9.5
[restores a shell with no extra launch environment](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/restore.rs#L568-L580)
while [retaining the persisted native-session reference](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/restore.rs#L687-L713).
The new pane has the current native environment and an empty reference; the
saved SQLite ID chooses resume or fresh execution. Static task/claim/worktree
identity stays unchanged. Live agents reconnect without recreation, and inactive
references are not promoted into the row's session_id.

Capacity is the claim-deduplicated union of local active rows, actual attributed
resources, already selected terminal cleanup and pending adapter stop
confirmations. A rowless orphan keeps its reservation and same-task barrier
until cleanup finishes, even when its pane is already closed and the remaining
responsibility is Git deletion or stop confirmation.

Still-owned local active tasks are queued for fresh target recovery before
global Git discovery. Their reservation already exists, so an unrelated
checkout's filesystem error must not suppress their progress. Pending startup
and new acquisition still require successful full discovery to account for
unknown managed resources before reserving another slot.

Each successful slot allocation advances Project rotation, for both pending
startup and new acquisition. Project-local pending order is stable, and new
candidates retain server ready order. This keeps spare capacity from being
consumed by one busy Project's entire batch.

Known-target cleanup and shutdown observe the target's Herdr execution and
validate only the target Git worktree when deleting. Sibling or unrelated Git
registration problems remain diagnostics, without preventing healthy agents
from stopping. Resource discovery still reports those problems separately.

The cleanup criterion originally required an idle, interactive-ready
submitPrompt receipt and later advancement of both sequence counters to avoid
counting an old business turn as the requested cleanup. The
[agent patrol decision](../bug-fix/2026-10-27-worker-agent-patrol.md) supersedes
that criterion: successful notification followed by a fresh idle observation
allows stopping, without requiring counters or interactive readiness. Notification
failures and unknown results retain the bounded deadline and visible error.
Input observations and cleanup progress remain process-local. This criterion
applies to normal terminal cleanup. The
[direct shutdown decision](../bug-fix/2026-10-28-worker-direct-shutdown.md)
owns worker process exit: cancel and join all jobs, including terminal cleanup,
then directly stop agents and close workspaces without a cleanup prompt or turn.
Claims, worktrees, native session IDs and unfinished rows remain even for ended
owners; the next normal inventory re-enters their terminal cleanup. Stop errors
remain visible and uncertain stopping retains the private daemon.

Configuration and recovery/cleanup state are process-local. A restarted process
uses the current applicable model/args for the recorded agent type. Cleanup has
a ten-minute deadline within its current attempt; after interruption, a new
inventory and resource observation starts another attempt. Recovery counts reset
with the process. Logs diagnose operations and never supply a recovery ledger.

Manual commands require a stopped runner and acquire its same instance lock.
They synchronously operate on one claim. Release stops the agent and
closes its workspace, submits the version-bound remote change, then deletes the
worktree after ownership is confirmed ended. A refusal retains the checkout for
source recovery. Unknown/interrupted management must be reconciled by the
operator before restarting run; there is no durable control intent.

The [force-withdrawal decision](../architecture/2026-10-27-worker-force-withdrawal.md)
removes transfer and exposes a separate Web owner/admin operation. It atomically
clears the reviewed active/released claim, returns the task to todo, clears timing
and sets allowAgents=false without asserting that the source process stopped.
The original worker discovers absence through complete inventory and cleans its
resources. Release and fresh resume retain their controlled local paths; there
is no target handoff or local old-schema retirement protocol.

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

**Reuse a restored inactive pane directly.** Its retained native reference does
not establish that the restored shell has the task's native environment. Fresh
current-resource recreation restores that environment and clears the stale
reference without bringing back durable workspace or launch receipts.

**Gate a known stop on a repository-wide worktree scan.** It exposes sibling
registration failures, but couples an unrelated checkout to the target agent's
termination. Direct target observation and deletion validation retain safety
while keeping failures local to their actual resource.

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
budget, old model/args or an interrupted management decision. A NULL native ID
starts a fresh conversation with an `info` event; if a prior conversation existed,
its continuity can be lost. Management takes the runner offline. The state
directory is for one configured service/account/worker identity; changes require completing
old executions and rebuilding local state.

Known unversioned minimal indexes are adopted at format version 5, preserving
rows and adding the existing Herdr mode where it was absent. The retired detailed
schema still has no conversion or automatic deletion: an operator stops the old
worker and removes that old SQLite before new-schema startup, retaining workerId
and native history. The SQLite migration decision owns that format distinction. Component checks and schema verification do not
establish native conversation or cross-platform whole-Goal acceptance.
