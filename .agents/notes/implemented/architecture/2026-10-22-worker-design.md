# Agent Note: Worker Design Boundaries

Status: implemented

## Problem

Ready tasks do not identify whether automatic execution is allowed or which
machine may execute them. A long-running worker also has to preserve task
ownership and work across process failure while using agents whose terminal
state does not prove delivery. Combining these concerns in an agent prompt or
the existing review coordinator would leave ownership, resource cleanup and
recovery dependent on unrelated execution behavior.

## Decision

The worker retains the responsibility split defined here: service ownership,
worker scheduling and resources, Herdr terminal control, and agent business
delivery. Current local records and restart behavior are owned by the
[six-column simplification](../simplification/2026-10-27-worker-claim-records.md).
The following preserves the original state-root and checkpoint design, including
why those stronger persistence guarantees were initially selected.

### Original implementation and rationale

The adopted [requirements](../../../../docs/spec/daynight-worker.md) and
[architecture](../../../../docs/design/daynight-worker.md) define a foreground
worker with four responsibilities: the service owns eligibility and exclusive
claims; the worker owns scheduling, resources and recovery; Herdr owns agent
terminals and sessions; the agent owns task delivery, acceptance and final
claim-bound completion under the [explicit completion
decision](2026-10-26-worker-managed-completion.md). The original design assigned
an independent completion-verification step to the worker; that portion is
superseded by the agent-owned completion and claim-inventory reconciliation
boundaries. The [managed execution decision](2026-10-26-managed-task-skill.md)
separates the ordinary and managed skill instructions. The worker constructs
startup and same-claim relaunch prompts with an explicit worker-managed
environment, using-daynight skill, autopilot-managed-task mode and original
assignment; the Herdr adapter transports that prompt to the selected native
agent. The [foreground runtime](2026-10-27-foreground-worker-runtime.md)
implements that composition; this note owns the responsibility decision. The [claim foundation
decision](2026-10-24-worker-claim-foundation.md) owns implemented service/client
ownership, status fencing and protected-property operations; it does not
establish resource startup or recovery. Automatic-execution permission and
optional platform persistence, filtering and service/CLI/Web controls are
implemented under their decisions below.

Eligibility combines `allowAgents=true`, ready state, optional platform
compatibility and the absence of an active claim. The service checks these
conditions and the exact task version atomically. The [automatic-execution
permission decision](2026-10-23-task-agent-automation.md) owns that field, its
defaults and confirmed Web changes. The [platform
decision](../feature/2026-10-24-task-required-platform.md) owns nullable
requirements, versioned setting/clearing and compatibility filtering. The
original design expressed this distinction as a Human/Agent processing role so
manual tasks could remain ready without being selected automatically. That role
decision is superseded by the boolean permission; the responsibility and
recovery decisions in this note remain in force. Protected task properties
expose execution ownership without allowing ordinary property updates to replace
it. The existing authentication and [three-state
setting](2026-10-24-task-status-assignment.md) remain prerequisites rather than
new worker-specific identity or task-state systems. The initial design used the
then-current approval lifecycle; the three-state decision owns its replacement.

The worker retains the original worktree and native history while the same claim
remains valid, and uses one dedicated Herdr instance with per-task workspaces.
The [local-records decision](2026-10-26-worker-local-records.md) partially
supersedes the initial explicitly configured workspace state directory and
worker_state/executions schema. The initial choice gave new resources an
explicit workspace owner and tracked external-action uncertainty. Stable
workerId now lives in shared configuration; fixed per-user worker resources and
the concrete projects/tasks schema provide that identity, exclusion and recovery
ownership. Identity, storage and the [owned Git
workspaces](2026-10-26-worker-git-workspaces.md) are delivered as concrete
primitives. The [private Herdr adapter](2026-10-26-worker-herdr-adapter.md) owns
instance isolation, native preflight, input uncertainty and concrete stop/rebind
operations. The [foreground runtime](2026-10-27-foreground-worker-runtime.md)
composes these modules with strict configuration, capacity, reconciliation and
durable unknown mutation fences. The
[manual-control decision](2026-10-27-worker-manual-control.md) owns explicit
management commands and the terminal new-execution protocol. Command
availability and targeted observations do not establish whole-Goal or
three-platform acceptance.

The worker reads the latest Herdr status for execution observations. The agent
validates delivery against task requirements, PR facts and acceptance evidence,
then submits the same claim's final done. Complete current-claim inventory
governs resource reconciliation rather than a second business-acceptance
verifier. Uncertain external results are reconciled before actions are repeated.
Waiting and paused tasks retain their claims, worktrees and global concurrency
slots. Every ownership exit uses the same terminal stop/close/delete cleanup; a
new claim starts fresh resources rather than importing the old execution.

Acquisition discovers eligible unclaimed tasks and lets the service atomically
select one winner. The original recovery design discovered work only through
known local/imported task IDs. The [current-claim inventory
decision](2026-10-26-worker-claim-inventory.md) partially supersedes that
discovery mechanism: the project task list supplies current authenticated
user/worker active claims without adding projections or a claim table. Complete
project/page traversal is required before absence can authorize reconciliation,
and candidate eligibility filters are not inventory filters. Known-task reads
still reconcile explicit versioned writes and unknown mutation outcomes.
Ownership discovery does not recreate missing worktrees, frozen configuration or
native history; those remain concrete recovery issues.

## Alternatives

**Discover owned tasks through a server inventory.** Listing tasks by user or
worker could rediscover ownership after losing local state, but it cannot
restore the original worktree, frozen configuration or sessions. SQLite already
retains the task IDs needed for normal recovery and uncertain-write
reconciliation. Direct reads of those known tasks avoid another discovery API
and its storage projections without treating missing local resources as
recovered work.

**A worker-owned delivery engine.** Moving implementation, PR creation,
CI/review handling and merge orchestration into the coordinator would duplicate
the agent's task workflow and make every repository delivery rule a worker
integration. The original design retained that loop in the agent while assigning
completion verification to the worker. Agent-owned final completion now
supersedes that verification step; ownership and resources remain with the
worker.

**A public report command and SQLite inbox.** A structured command could accept
waiting, failure and delivery-candidate messages with deduplication identifiers.
It would introduce a public agent protocol, report lifecycle and recovery rules
when Herdr status and existing task evidence cover the required observation. The
design therefore has no report command or report event stream.

**Structured result files.** Files could bridge an agent process to an internal
report handler, but would add another result format and persistent resource to
reconcile. The worker uses existing task evidence and current Herdr state.

**A shared review and worker execution engine.** Review has its own PR revision,
publication and conversation lifecycle. Worker ownership spans implementation,
human waits and crash recovery. Reusing REST, configuration and Git utilities
keeps common mechanisms available without imposing one coordinator or SQLite
schema on these different lifecycles.

## Consequences

The original consequences below apply to the initial worker_state/executions
checkpoint model. The current simplification replaces those storage details;
the service, native integration and independent platform-verification boundaries
remain in force.

### Original consequences

The design keeps exclusive ownership and crash recovery explicit without a
second agent reporting protocol. Lost external responses cannot justify another
agent or repeated input. Worker death does not expire ownership automatically.
The original transfer design required access to source results; the
local-records decision replaces that continuity assumption with terminal source
cleanup and a fresh target execution. The
[manual-control decision](2026-10-27-worker-manual-control.md) replaces the
service continuity checks with fresh claim/worktree identities and strict
rejection of the obsolete confirmation input. The
[force-withdrawal decision](2026-10-27-worker-force-withdrawal.md) then removes
transfer and uses an atomic manual-control reset, with original worker cleanup
triggered by complete inventory absence.

Herdr idle/done is only an execution observation. The agent performs task
acceptance, records evidence and submits final claim-bound done. Conflicting or
missing evidence and explicit human acceptance requirements keep the task
unfinished for work or human input. The worker uses complete current ownership
for cleanup and does not independently parse business acceptance or PR evidence.

Native Herdr transport, unattended session restoration, stopping and both agent
adapters require source-bound runtime acceptance on supported platforms. Design
documentation does not establish those capabilities. A new report protocol or
shared coordinator should be reconsidered only when concrete required behavior
cannot fit these observation and responsibility boundaries.
