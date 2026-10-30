# Agent Note: Design staged Goal task chains

Status: implemented

## Problem

Multi-task work needs a clear statement of the complete outcome before architecture
and delivery tasks are fixed. The earlier registration rule required finished solutions
and frontend prototypes, so applying that rule to problem-definition or design
tasks makes their outputs prerequisites to starting them. A root task's
completion also needs to remain distinct from delivery of the entire task chain.
A task whose description only names a general problem and links cannot communicate
its concrete assignment without opening a packet of attachments. Repeating common
requirements and designs on each task also creates several copies with unclear
ownership and independent update lifetimes. Independent acceptance also needs a
clear result of its own: a conclusion about the requested outcome can otherwise
turn into building and maintaining verification tools, leaving the complete
requirements unassessed.

## Decision

The [Goal requirements](../../../../docs/spec/daynight-goal-workflow.md) and
[design](../../../../docs/design/daynight-goal-workflow.md) own the current protocol.
The [user-confirmed discussion decision](2026-10-24-user-confirmed-goal-discussions.md)
replaces this decision's initial-pair registration, pre-confirmation delivery
breakdown and discussion completion rules. The original architecture was delivered separately
from its dependent protocol implementation and independent consumer acceptance.
The [mode decision](../../archived/architecture/2026-10-21-using-daynight-modes.md) records the original
entrypoint and authorization choices. The
[task-content and handoff decision](2026-10-25-task-content-handoff.md) replaces
mandatory primary-attachment ownership while retaining stage and shared-source
rules. The [managed execution decision](../architecture/2026-10-26-managed-task-skill.md)
subsequently removes the ordinary skill's scheduling mode and separates
worker-selected execution; the original control-flow rationale remains below.

A Goal uses existing tasks, attachments and dependsOn. The original registration
created a Goal description task titled `[Goal]<outcome>` and a dependent
architecture-and-breakdown placeholder together. Stage briefs allowed unresolved
requirements and design to remain outputs of their producing stages. Goal
description fixed the problem, outcomes, scope, exclusions and verification without
production implementation or architecture work. Applicable UI requirements included
a final-style interactive frontend-only prototype. Current prototype constraints
belong to the [task-creation owner](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/create-task.md#prepare-content).
Architecture fixed mechanisms
and registered the actual delivery breakdown before implementation became ready.
Sequential user-confirmed discussions now govern when those tasks are created
and completed; the stage-produced-output rule still applies.

Every task description identifies the current task, its responsibility and readable
sources. Its body and required references jointly provide the task definition
and existing artifacts under the [task/session content decision](2026-10-28-task-session-content.md);
a complete description needs no primary attachment unless managed delivery
requires attachments, as recorded by the
[reference ownership decision](../architecture/2026-10-29-daynight-skill-reference-ownership.md).
Goal tasks cover their agreed
whole outcome, while implementation and acceptance tasks retain their own assignments.
Each detailed explanation has one owner. The original brief-plus-primary-attachment
structure separated stable detail from transient progress; single content ownership
and session checkpoints retain that rationale without requiring a task execution
plan or a generic confirmation/evidence location.

Materials follow content ownership. Requirements stay with the Goal requirements
task; architecture owns its design and registered breakdown; implementation and
acceptance own their agreed artifacts and results. These may be in task bodies
or required referenced documents. Execution/discussion plans, operational
authorization, confirmation exchanges and recovery information remain session context. Every delivery description directly
identifies the architecture task and each required source, including indirect
successors whose direct prerequisite is another implementation task. Shared body
content names its owning task ID, the description field (whole body or applicable sections),
read with task show; real attachments retain complete paths. Repository documents
retain the owning architecture task and verified immutable references. Inline
architecture needs no fabricated file path or copied attachment. Registration checks each description's source index; executors read
the listed inputs before implementation. This gives independent consumers the
confirmed design's location without copying its content or changing dependency
edges. Existing CLI reads support those references; no new link scheme or API is
introduced. An independently required snapshot must name its source version and
purpose.

Final acceptance determines whether the complete confirmed task or Goal, including
confirmed changes, satisfies its requirements. The canonical
[Final acceptance rule](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/final-acceptance.md)
owns this shared boundary. Creation identifies the whole acceptance subject and
requirement sources; Goal breakdown and execution use that same rule. The owning
task delivers the requirement-based conclusion, defects and unverified items,
with necessary source identity, supporting observations and material limits.
Verification methods and execution history remain in the session unless an agreed
method document is itself a deliverable; no receipt format or evidence platform
is required.

Manual verification, existing checks and temporary helper scripts are valid
methods. Final-acceptance helpers remain uncommitted and are not integrated into
repository tests, fixtures, runners, CI or tooling. Completing or passing helpers
does not establish whole-task or whole-Goal acceptance, and helper review findings
do not authorize a maintained verification system or a separate helper PR gate.
Necessary implementation PRs retain their delivery requirements. Normal
implementation and authorized defect fixes retain their unit, integration and
regression tests and repository checks; explicitly requested maintained automation
remains a development deliverable within its own confirmed scope.

The initial protocol retained four skill modes and made create-task register the pair
and return, run-task execute one stage, and explicitly activated autopilot select
successors. Scoped Goal-creation permission covered the pair and its agreed
breakdown, while the [approval lifecycle](../feature/2026-10-22-task-approval-lifecycle.md)
created each task proposed and required explicit approval before claim. Planning
stages originally shared the PR-delivery completion rule. The successor decision
now uses explicit discussion-start or transition requests to start the specified
stage and user-confirmed material for discussion completion. The adopted
[status assignment decision](../architecture/2026-10-24-task-status-assignment.md)
removes task approval, registers todo without execution and uses versioned status
setting within the existing execution scope. Actual delivery retains its
execution/merge authorization. Requirements completion does not complete a Goal.
The managed execution decision removes autopilot successor selection from the
current skill. Ordinary run-task still performs one specified stage and its
explicit user-directed discussion transition; managed execution returns after
its one assignment without advancing the Goal.

## Alternatives

**Require the full solution and prototype before every registration.** This is
appropriate for an implementation task whose design is an input, but prevents
starting a stage whose purpose is to produce those artifacts. Stage-specific entry
requirements preserve complete implementation inputs without creating that cycle.

**Implement the skill alongside its design.** This provides one combined artifact,
but makes the design task's successor execute before its prerequisite is delivered.
Separate design and implementation PRs preserve the workflow's delivery gate.

**Introduce a separate Goal resource or CLI mode.** Existing task dependencies and
attachments already represent the required sequence. A new resource would require
runtime and persistence changes beyond the skill workflow; a fifth mode would
duplicate registration or single-task execution ownership.

**Keep whole-Goal consumer acceptance inside the implementation task.** This keeps
all verification under one task, but obscures the distinct result of independently
checking the immutable delivered artifact and reconciling the complete Goal. Separate
post-delivery acceptance makes that result explicit while retaining every required
implementation check before merge.

**Make a maintained verification system the final-acceptance deliverable.** Durable
runners, fixtures or CI can be useful when explicitly requested as development,
but making them the result of a final-acceptance assignment adds tool maintenance
and a helper PR gate without establishing whether the requested outcome is complete.
Temporary methods and a requirement-based conclusion preserve that assignment's
purpose while keeping ordinary implementation and regression checks intact.

**Restrict descriptions to problems and distribute the common document packet.**
This keeps detailed prose in attachments, but hides each concrete assignment and
replicates documents owned by the Goal or architecture. A self-contained brief plus
owned detail and verified shared references makes the work readable while retaining
one source for common inputs.

## Consequences

The original protocol required two initial tasks and recoverable attachment writes,
with real successor registration before design handover. The successor decision
delays architecture-task creation until accepted requirements and a user-requested
transition, and delays delivery-task registration until the user accepts the
solution. Actual registered outcomes and verified artifacts remain necessary;
a future task list or one vague implementation placeholder is insufficient.
Protocol delivery and independent consumer acceptance have different completion
evidence and both remain in the same Goal scope. Acceptance can finish without a
code change or helper PR when the confirmed whole-outcome criteria and readable
evidence are satisfied. Required outcomes that remain unmet or unverified prevent
an accepted conclusion. Defects retain their actual failed criteria; authorized
fixes and affected rechecks follow normal delivery rules. Temporary helper files
and resources are cleaned under the repository's existing resource rules, while
necessary observations remain on the owning task.
Definition and design can start with honest stage briefs, while implementation
retains completed requirements and design as inputs. Instruction review must cover
stage transitions, permission boundaries, partial registration and whole-Goal
completion, task responsibility and reference comprehension, and content ownership;
recursive copy and installer checks establish artifact integrity
separately from instruction behavior. The architecture-to-A-to-B scenario checks
that B directly retains its applicable architecture references and that an
executor with no discussion history reads them before implementation.

The protocol adds no server-side enforcement, lock, state, telemetry or migration.
Existing version and attachment concurrency rules still apply. The current task
chain provides a concrete registration exercise, not proof that every model
will follow the skill. Publishing, deployment and PR merging remain subject to
their own authorization and observed platform state.
