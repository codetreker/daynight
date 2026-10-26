# Agent Note: Foreground Worker Runtime

Status: implemented

## Problem

Claim ownership, local persistence, Git worktrees and native terminals have
separate failure boundaries. A foreground process must compose them without
turning a lost response into another claim, native conversation or prompt. It
also needs to retain original responsibility during pauses and cleanup while
sharing a global execution limit across repositories.

## Decision

The installed `worker run` command lazily loads its own runtime, strict worker
configuration and fixed user state. The [worker
design](../../../../docs/design/daynight-worker.md) owns the mechanisms; the
[user
guide](../../../../packages/daynight/README.md#worker-configuration-and-startup)
owns configuration and operation. Review keeps its own database, coordinator and
lifecycle. Worker composes existing typed HTTP, identity/lock, Git, Herdr and
managed-skill modules instead of introducing another delivery engine.

A single coordinator owns repository rotation, capacity and per-task serial
advancement. Every inventory/acquisition round reads complete current own-claim
inventory before reconciling records and Herdr resources, then acquires new
work. Failed or partial inventory cannot authorize a new terminal decision. Only
original-claim absence triggers new automatic terminal cleanup; task status does
not classify exits. Explicit source control and irreversible terminal intent
precede ordinary recovery. A new claim never protects an old claim with the same
task ID.

Actual claims become pending before activation and resources. Active
preparation, waiting, paused recovery and cleanup retain capacity; lowering the
limit does not preempt existing work. Rediscovered original resources with
missing frozen configuration retain a paused reservation rather than becoming
free capacity. Same-claim recovery retains its worktree, native identity and
configuration. One private Herdr instance serves all task workspaces.

The local store keeps only projects and tasks. Schema 2 adds a concrete nullable
claimAttempt to each project and nativeExecution facts to each task, with an
explicit migration that leaves absent original evidence unknown. ClaimAttempt
records one unresolved task/claim/worktree/worker request, exact version and
decision configuration before HTTP. An actual matching claim materializes
pending and clears the attempt atomically. Definite rejection or proven
non-submission can clear it; an unknown request cannot be replayed, replaced or
cleared because an inventory temporarily lacks it. No task row exists before
grant, and no new table or acquisition queue is introduced.

NativeExecution records the actual terminal, workspace submission, verified
workspace/launch receipts, launch/prompt submission facts, immutable original
stop observation and a versioned execution-summary write. Unknown workspace
creation is not repeated because a snapshot temporarily lacks it; an observed
owned result is reconciled before any fresh environment-receipt rebind.
Submission responsibility is durable before external calls. A proven locally
undispatched current attempt can restore its never-submitted state; real
uncertainty remains fenced. Neither an empty pane nor a current rejection erases
an earlier unknown action. These are concrete consumer fields, not a generic
action log.

This partially supersedes the memory-only acquisition choice in the
[local-records decision](2026-10-26-worker-local-records.md). That choice
avoided preclaim tasks and speculative target records while inventory could
rediscover ownership. The running consumer also needs to remember an uncertain
outbound request across restart, so the specific project field closes that
window while preserving actual-claim-only tasks and the two-table ownership
model.

The runtime validates the installed using-daynight bundle and builds an explicit
worker-managed / execute-task-in-managed prompt with absolute installed entry
and reference paths, original assignment, actual platform and frozen settings.
The agent owns business delivery, acceptance, evidence and final claim-bound
done. Live reconnection does not repeat startup input. The [Herdr
adapter](2026-10-26-worker-herdr-adapter.md) owns transport and resource
observations, and its receipt/stop gates remain authoritative.

Cleanup retains its first deadline and input provenance. A lightweight discovery
loop inside the foreground process starts one transient job per complete
origin/project/task/claim identity with persisted cleanup or source-control
intent. Each job calls advanceCommittedCleanups(identity) and independently
waits at most one second, shortened to its nearest original deadline. A held
resource request for one task does not make other tasks wait for the whole batch
before their next advance. Same-task resource operations still share the serial
boundary. These jobs operate independently of server acquisition polling and
startup repository requests, without a persisted queue, table, ledger, public
configuration or OS daemon. A failed read creates no new absence decision and
cannot withdraw an already committed cleanup responsibility.

The driver requests attributable outside-worktree cleanup, observes a fresh
completion boundary or fixed deadline, confirms original stop, closes the
workspace and deletes the original Git worktree before local done. Unknown
cleanup input is not replayed. Ctrl+C cancels and joins the normal committed
cleanup discovery loop and all per-claim jobs before the independent bounded
shutdown scope and shared exit deadline. The private Herdr instance stops last,
after original agents are confirmed stopped.

Consuming completed interrupted shutdown invalidates its old Herdr snapshot;
ordinary execution first enumerates current resources again. Proven
never-started work or an execution with its exact original native ID can take
the normal resume path while preserving worktree/configuration, recovery budget
and pause state. If native execution may have started but its exact ID is
unavailable, confirmed stopping/closure does not authorize first launch:
original bindings, launch/prompt provenance and PID evidence are retained and
execution pauses. That uncertainty is not reset to never-submitted or an empty
conversation.

The public attachment descriptor is advertised only after complete inventory and
managed private-instance/snapshot readiness. It applies routing variables only
to the attach client. It does not change the existing task pane's original
native XDG or private HISTFILE. It exposes required paths and identity removals,
without copying credentials. Diagnostics correlate original IDs, local state,
recovery and cleanup errors; neither diagnostics nor terminal idle/done
authorize task completion.

## Alternatives

**Keep request identity only in memory.** Complete inventory recovers a
successful claim, but a restart cannot remember a still-uncertain outbound
request and may acquire again before that request settles. A project-scoped
descriptor retains that single uncertainty without creating a task or
generalized action ledger.

**Create pending before remote grant.** That conflates intended acquisition with
actual ownership and would require another lifecycle for rejected/ungranted
work. Projects can retain request uncertainty while task rows continue to mean
actual claims only.

**Use one reusable review/worker workflow engine.** Review owns captured PR
revisions and publication rounds; worker owns service claims, capacity and
long-lived original resources. Their concrete state and completion boundaries
differ. Narrow shared HTTP, filesystem and process primitives preserve reuse
without merging the two lifecycles.

**Infer restart safety from missing resources.** A native launch or prompt can
succeed before its reply or local result commits. Persisted submission facts and
actual resource/provenance checks distinguish never-started work from an unknown
execution. Fresh replacement resources cannot conceal lost history or config.

**Use acquisition polling to schedule committed cleanup.** A long poll interval,
failed server inventory or blocked startup project request can delay a deadline
that was already accepted and persisted. A narrow foreground cleanup loop keeps
that commitment progressing without obtaining new termination authority or
creating another resource controller.

**Wait for all tasks in each cleanup batch.** Even when calls within a batch run
concurrently, joining the entire batch before the next round makes one held task
request delay another task's deadline. Independent per-claim jobs retain each
original timing commitment; they are joined together only when the foreground
process stops.

**Reset any stopped execution to first launch after shutdown.** Process stop and
workspace closure do not identify the original conversation. When a launch may
have happened without its native ID being retained, clearing old provenance can
start a new conversation under the old claim. Pausing with the original evidence
preserves that boundary until the exact identity is recovered.

## Consequences

The command, discovery loop and transient cleanup jobs remain one foreground
process rather than another server or OS background service. Configuration
defaults and repository overrides have one strict owner; startup reload affects
new assignments while existing ones keep their snapshots. Fixed paths and a
stable worker identity give restarts the same record/resource scope.

An unresolved project acquisition or missing original native proof can require
inspection while other eligible work continues within available capacity.
Conservative uncertainty stays visible instead of being represented as success,
rejection or a new empty conversation. Component tests, installed-command
checks, real service behavior and native-agent lifecycle evidence remain
distinct.

Manual release/transfer/resume/retry commands and the service's existing
continuity restrictions still require their own delivery. Complete Linux,
Windows and macOS Goal acceptance is separate from this runtime composition;
shipping the command does not assert those final results.
