# Agent Note: Confirm Goal specifications and register required successors

Status: implemented

## Problem

A requirements discussion can leave its complete outcome spread across a task
body, shared references and conversation context. A completed requirements task
then gives architecture a dependency without a single independently readable
specification to review and consume. Confirming a discussion summary also leaves
ambiguity about whether the user accepted all required behavior and whole-Goal
acceptance criteria. Task versions cannot resolve that ambiguity because
attachment writes do not change them.

Finishing a task before its required successor exists creates another gap: the
current result appears closed while the already-defined following work has no
tracked owner. A requirements-to-architecture transition can leave accepted
requirements done with no architecture task when successor creation fails.

## Decision

The Goal requirements task owns a complete `spec.md` attachment in addition to
its self-contained description. The description identifies the assignment,
scope, deliverables, completion conditions and specification location; the
specification owns the full requirements without duplicating them in the body.
The [Goal requirements](../../../../docs/spec/daynight-goal-workflow.md#阶段资料与确认)
own the applicable content and completeness criteria, and the
[Goal design](../../../../docs/design/daynight-goal-workflow.md) owns the stage flow.

Registration still accepts an initial brief. The specification is a requirements
stage output, and its absence does not prevent starting the discussion. Before
requesting confirmation, upload the complete current specification and required
resources, read back their actual contents, and provide the requirements task ID
and attachment paths. Explicit confirmation of that current specification
together with direction to enter architecture permits registration of that next
discussion. Requirement or acceptance blockers must be resolved; architecture
choices remain design work. Applicable final-style interactive frontend prototypes
remain requirements-owned resources referenced from the specification.

Task completion requires both the current result and verified registration of
required successors when the confirmed scope contains following work. Existing
creation authority must cover those registrations. A terminal task needs no
invented successor, and routine execution steps do not become tasks. The
[Goal protocol](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/goal.md#register-the-next-discussion-before-completion)
owns the stage-specific registration gates, while
[authorization and scope](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/authorization.md#scope-and-continuity)
keeps required registration within current-task closure and existing authority.
The gates grant no additional registration or successor-execution authority.

After specification confirmation and explicit direction to enter architecture,
create or reuse the architecture task while requirements remain in_progress.
Its ordinary dependency on requirements keeps it todo and blocked. Its description
directly identifies the requirements task ID, `spec.md` path and applicable
prototypes; read back the task, actual sources and relationships. Only after
that registration is verified may requirements complete. Confirm the done result
before the ordinary entrypoint starts the registered architecture discussion.
Solution discussion likewise registers and reads back its confirmed delivery
breakdown before completing. Failed or uncertain registration leaves the current
task in_progress; preserve confirmed IDs and reconcile partial writes.

Managed execution can register and read back already-confirmed required successors
under existing creation authority as part of the original assignment's completion.
It still completes only the original claim and returns to the controller without
selecting, starting or executing successor work. Missing creation authority or
required content keeps the original task incomplete and follows the existing
human-interaction path. Confirmation gates still apply before any Goal-stage
registration.

Incomplete or unreadable specifications and failed uploads do not satisfy the
requirements gate. Substantive requirement changes synchronize the complete
specification, related description and prototypes and require renewed
confirmation. A task version alone does not establish that the current attachment
is still accepted. The task stores accepted requirements and their effective
state; confirmation exchanges and operational authorization remain session context.

This partially supersedes the general inline-sufficiency choice in the
[content/handoff decision](2026-10-25-task-content-handoff.md) and its current
applications in the [original Goal decision](2026-10-22-goal-workflow-design.md),
[task/session content decision](2026-10-28-task-session-content.md) and
[Markdown description decision](../architecture/2026-10-22-task-description-markdown.md).
It adds a concrete specification gate and replaces done-before-create ordering in
the [user-confirmed discussion decision](2026-10-24-user-confirmed-goal-discussions.md).
The [managed execution decision](../architecture/2026-10-26-managed-task-skill.md)
retains its single-assignment execution boundary while applying the shared
required-successor registration gate. Their original isolated-reader,
single-owner and stage-produced-output rationale continues to apply. Ordinary
tasks retain inline, referenced or mixed material unless their delivery contract
requires attachments. Managed artifact requirements remain independently applicable.

## Alternatives

**Allow a complete requirements description without a specification attachment.**
The content/handoff rule avoided mandatory files for otherwise complete tasks.
For a Goal it also allowed the transition without a dedicated, complete review
artifact. A stage-specific specification requirement keeps ordinary tasks'
flexibility while giving architecture an explicit accepted input.

**Require the final specification when registering the Goal.** That would make
requirements completeness a prerequisite to the stage that produces it. An
initial brief followed by a mandatory stage deliverable preserves discussion
entry while enforcing completeness before architecture.

**Complete requirements before registering architecture.** The original sequential
discussion protocol made predecessor completion the creation gate. It avoided
an early next-stage task, but a failed registration could leave no tracked
successor after the prerequisite closed. User confirmation still prevents
premature registration; an ordinary dependency keeps the registered successor
blocked until the predecessor is actually complete.

## Consequences

The requirements stage has explicit specification, user-confirmation and
successor-registration gates. Its description stays useful by itself while
detailed requirements have one owner; architecture consumers can locate the
accepted specification without reconstructing the conversation. Maintainers
must keep applicable resources and requirements coherent when the specification
changes. A task with required following work stays open until that work has
verified task identities and inputs, without starting it or widening execution.

Existing task, attachment and dependency operations carry the protocol. No new
resource, status, command, storage format, attachment certification or historical
task migration is introduced. Independent writes remain non-atomic, so actual
content readback, preserved IDs and renewed confirmation handle revisions and
partial registration; metadata versions are not immutable snapshot certificates.
Semantic review checks missing, unreadable, changed and unconfirmed specifications,
registration failures, terminal tasks and both execution modes separately from
packaging and installation byte checks. These checks do not prove universal
model compliance.
