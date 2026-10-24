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
ownership and independent update lifetimes.

## Decision

The [Goal requirements](../../../../docs/spec/daynight-goal-workflow.md) and
[design](../../../../docs/design/daynight-goal-workflow.md) own the current protocol.
The [user-confirmed discussion decision](2026-10-24-user-confirmed-goal-discussions.md)
replaces this decision's initial-pair registration, pre-confirmation delivery
breakdown and discussion completion rules. The original architecture was delivered separately
from its dependent protocol implementation and independent consumer acceptance.
The [mode decision](../architecture/2026-10-21-using-daynight-modes.md) continues to
own the current entrypoint and authorization rules.

A Goal uses existing tasks, attachments and dependsOn. The original registration
created a Goal description task titled `[Goal]<outcome>` and a dependent
architecture-and-breakdown placeholder together. Stage briefs allowed unresolved
requirements and design to remain outputs of their producing stages. Goal
description fixed the problem, outcomes, scope, exclusions and verification without
production implementation or architecture work. Applicable UI requirements included
a final-style interactive frontend-only prototype. Architecture fixed mechanisms
and registered the actual delivery breakdown before implementation became ready.
Sequential user-confirmed discussions now govern when those tasks are created
and completed; the stage-produced-output rule still applies.

Every task description is a self-contained brief for that task: its problem, concrete
scope and actions, deliverables, constraints, and observable completion summary must
be visible before following attachments. Goal descriptions state the complete Goal;
implementation and acceptance descriptions state their own assignments. Detailed
solution, complete acceptance and evidence remain with the task-specific primary
Markdown attachment. Summaries and details have distinct roles and are maintained
together within the owning task.

Attachments follow content ownership. The Goal owns goal.md; architecture owns its
phase plan, design and registered breakdown; implementation and acceptance own only
their respective plans and later evidence. Every delivery description directly
identifies the architecture task and relevant document attachment paths, including
indirect successors whose direct prerequisite is another implementation task.
Repository documents retain the owning architecture task and verified immutable
references. Registration checks each description's source index; executors read
the listed inputs before implementation. This gives independent consumers the
confirmed design's location without copying its content or changing dependency
edges. Existing CLI reads support those references; no new link scheme or API is
introduced. An independently required snapshot must name its source version and
purpose.

Four skill modes remain. The initial protocol made create-task register the pair
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
evidence and both remain in the same Goal scope.
Definition and design can start with honest stage briefs, while implementation
retains completed requirements and design as inputs. Instruction review must cover
stage transitions, permission boundaries, partial registration and whole-Goal
completion, description-only assignment comprehension, and attachment ownership;
recursive copy and installer checks establish artifact integrity
separately from instruction behavior. The architecture-to-A-to-B scenario checks
that B directly retains its applicable architecture references and that an
executor with no discussion history reads them before implementation.

The protocol adds no server-side enforcement, lock, state, telemetry or migration.
Existing version and attachment concurrency rules still apply. The current task
chain provides a concrete registration exercise, not proof that every model
will follow the skill. Publishing, deployment and PR merging remain subject to
their own authorization and observed platform state.
