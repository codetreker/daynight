# Agent Note: Content-sufficient task handoff

Status: implemented

## Problem

An isolated execution Agent cannot reconstruct a task from a prior conversation,
private workspace or unstated permission. A link list can appear complete while
its targets omit the task's scope, design or input/output agreement. Conversely,
requiring a primary attachment rejects a complete task description and encourages
an extra copy of content merely to satisfy its storage location. Automatic-selection
permission also needs an explicit transition from reviewed task material to an
allowed candidate; creating complete material alone does not authorize that change.
A request can also mix durable task requirements with instructions for the current
conversation. Copying both into the task can turn a registration-only arrangement
into a lasting execution restriction or bury confirmed decisions in discussion history.

Complete individual descriptions can still form a poor Goal breakdown: independent
goals can be bundled, routine edits can become fragments, responsibility can
overlap, and integration or whole-outcome verification can have no owner. Content
sufficiency alone needs a distinction between the quality of one assignment and
the coverage and handovers of the complete set. An assignment can also drift
from its Goal when it lacks a task-specific contribution, boundary, substantive
approach or acceptance that demonstrates that contribution.

## Decision

The public `using-daynight` bundle has a `handoff <task-id>` mode and one shared
`references/task-content.md` standard. The description identifies the current
task, its responsibility and readable sources. Body content, required referenced
documents and mixed organization meet the same sufficiency test; a complete
description needs no primary attachment unless the Goal specification gate or
managed delivery requires one. The
[Goal specification decision](2026-11-02-goal-spec-confirmation.md) requires the
requirements task to deliver complete `spec.md`; managed attachments and separate
review files are recorded by the
[reference ownership decision](../architecture/2026-10-29-daynight-skill-reference-ownership.md).
Each detailed explanation has one owner.

The [Goal protocol](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/goal.md#register-the-delivery-breakdown)
owns delivery-task boundaries, briefs and whole-breakdown checks. Each delivery
task has one independently assessable outcome, with boundaries determined by
purpose and reviewability. A foundation, migration or acceptance task may have
its own result while depending on other work. Each proposed and registered
Goal delivery task supplies the
[delivery brief](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/goal.md#delivery-task-brief):
its objective's concrete contribution to the confirmed Goal, scope, substantive
implementation approach and observable acceptance. Precise readable source
sections can supply detail; a generic architecture pointer cannot define the
assignment. An acceptance task's approach defines its substantive verification,
while session command schedules and debugging remain outside task material.

The Goal protocol checks the complete candidate set before solution confirmation
and the actual registered set before solution completion. It verifies the four
brief parts against the Goal and applicable solution, complete scope, integration
and whole-Goal verification ownership, responsibility gaps and producer/consumer
agreement. Handoff checks content sufficiency and required sources or contracts;
for Goal delivery tasks it also checks their brief and boundary under that same
Goal owner. Missing approaches and Goal drift are content gaps handled under
existing state and permission rules. Handoff does not reconstruct the whole Goal
or authorize repartitioning and dependency changes.

The original standard used six categories, including a solution, validation
methods and a designated task-local confirmation/evidence location. Those choices
made independent consumption explicit and kept stable detail separate from
execution progress. The [task/session content decision](2026-10-28-task-session-content.md)
partially supersedes that content model: five definition categories plus current
and final artifacts replace the universal solution and evidence requirements.
The scoped Goal delivery brief requires a task-local approach without restoring
a universal plan or separate solution-file requirement; the task/session
decision retains the distinction between that substantive design and session
organization.
Task content retains real inputs, substantive approaches and outputs, while session execution/discussion organization,
operational authorization and recovery information stay in the session. The
shared rule governs descriptions, attachments and referenced task material;
existing entrypoint and creation references apply it without duplicating wording.

This partially replaces the mandatory primary-attachment storage rules in the
[mode decision](../../archived/architecture/2026-10-21-using-daynight-modes.md),
[Goal brief decision](2026-10-22-goal-workflow-design.md),
[Markdown description decision](../architecture/2026-10-22-task-description-markdown.md)
and [tracking/review decision](2026-10-24-daynight-tracking-and-design-review.md).
The original split kept stable plans distinct from transient execution progress
and prevented several competing copies. Single content ownership and separate
execution checkpoints retain that rationale while allowing complete descriptions.
The [user-confirmed Goal discussion decision](2026-10-24-user-confirmed-goal-discussions.md)
continues to own stage gates. Shared inputs remain with their actual owners.
Shared task-body content is referenced by its owning task ID, explicit description
field (whole body or applicable sections), and read through task show. Every Goal delivery
description directly lists the architecture task identity and every required
source: that description content, full paths for actual attachment documents,
or verified immutable repository references. Indirect successors retain the same
direct index; inline architecture does not require a fabricated path, copy or
relocation into an attachment.

Handoff requires the user's explicit authorization for its designated tasks.
It reads actual task content and necessary further references, checks the task
definition and existing artifacts for the current stage, and verifies applicable
upstream/downstream contracts. A session execution plan is not a handoff prerequisite.
Known, already-confirmed information can organize a not-yet-enabled todo;
missing decisions remain concrete blockers. A blocked todo may be handed off when
its design and interfaces are sufficient, while its dependencies still prevent
execution. The [account-owned handoff decision](2026-11-04-cli-create-default-assignee.md)
also requires comparing the explicitly selected task's assignment with the
independently confirmed authenticated account. Ownership checks do not enumerate
other tasks; unknown identity remains an unconfirmed prerequisite. Only after content and responsibility review
does an exact-observed-version update enable `allowAgents`; creation, breakdown, automatic discovery and execution never
supply that authorization themselves.

Already-enabled tasks receive a read-only re-audit. A failed re-audit preserves
permission and explicitly reports that scheduling exposure or execution remains;
revocation or stopping requires its own authorization and existing control flow.
Running-task permission locks and worker ownership remain in force. The
[manual-control decision](../architecture/2026-10-27-worker-manual-control.md)
retains original resources for an active claim and starts fresh resources after
release; permission handoff does not authorize either lifecycle operation. The mode's done policy reports that no handoff is needed without rewriting
history. Handoff returns after review and result reconciliation; it does not start
ordinary or managed execution, select a successor, or add execution and delivery
authority. The [managed execution decision](../architecture/2026-10-26-managed-task-skill.md)
owns the separate explicit worker entrypoint; this content standard applies to
both execution modes.

Task versions protect task metadata, not independent attachment or cross-task
writes. Required mutable sources are checked before enabling and again at
execution; a changed source triggers review of the affected content. This is a
best-effort content check, not an atomic snapshot or a permanent certificate.
Conflicts require a fresh decision, uncertain writes are reconciled by reading,
and unreadable results remain unconfirmed. Immediate worker claims may produce a
higher final version or in_progress state. Reports include actual assignedTo and responsibility conclusions and
do not attribute another writer's matching permission value to the handoff.

The [skill requirements](../../../../docs/spec/daynight-agent-skill.md) own
observable behavior, the [skill design](../../../../docs/design/daynight-agent-skill.md)
owns resource and flow responsibilities, and existing task/attachment contracts
continue to own mutations. The new resources use the existing recursive bundle
copy and installation path; no CLI command, API, schema or server certification
mechanism is added.

## Alternatives

**Require a primary attachment for every task.** This separated detailed plans
from descriptions and operational progress in the original workflow, but it
makes a complete body fail a storage rule. It also requires another file for
simple complete assignments. The later task/session boundary retains single
content ownership and real artifacts without requiring that file or a universal
evidence location.

**Copy complete shared requirements and designs into every task.** Each task
would be independently readable, but changes would create competing versions and
unclear owners. Accurate source identity, applicable sections and actual reads
provide the required context while preserving a single shared owner.

**Copy all conversation constraints into the task.** This preserves the request's
words but loses their scope: an instruction to register without executing or enabling
Agents in the current conversation can become a permanent task restriction.
The task/session successor separates real result constraints from session
methods and operational authorization; the current operation still honors its
original instructions without copying them into task prose.

**Treat a link or existing true permission as review proof.** A readable name
says nothing about content sufficiency, and permission can predate the current
material. The mode reviews actual content even when the flag is already true.

**Automatically revoke permission when re-audit fails.** This could reduce future
scheduling exposure, but changes existing permission outside the requested
review and cannot stop a running claim through the ordinary permission update.
Read-only re-audit reports the actual exposure; revocation and stopping remain
separately authorized operations with their own lifecycle constraints.

**Add server audit tokens or immutable attachment snapshots.** Those could enforce
that scheduling consumes certified bytes, but require a different server admission
and reference-version contract. The skill-only scope accepts independent writes
and reports that limitation. Any later strict certification must introduce those
mechanisms rather than infer a certificate from allowAgents.

## Consequences

The shared content standard controls definitions, sources and stage-specific
inputs and outputs across creation, handoff and execution. The Goal protocol owns
its delivery briefs, decomposition boundaries and whole-breakdown coverage;
individual handoff cannot certify complete Goal coverage. Goal decomposition uses
purpose and reviewability without fixed counts, sizes or a uniform slicing
pattern. A discussion's future decisions remain its outputs. The content standard
allows complete inline material while retaining current-stage requirements, real
dependencies, Goal confirmation and direct architecture-source indexing. Task inputs and resulting artifacts remain
findable through their actual owners. Ordinary tasks may keep complete content
in the description; Goal requirements use the mandatory complete specification
attachment. Session continuity does not become task material.

The flag permits automatic selection but does not certify future document
versions, pause scheduling or prove execution. Existing true tasks are not
rewritten in bulk. A stricter certified-content guarantee would require an
explicit server/reference redesign; leaving the flag without certificate semantics
keeps that later change visible rather than embedding a false guarantee.

Resource copying and isolated installation validate published files under the
[skill packaging validation decision](../testing/2026-10-30-skill-packaging-validation.md),
which partially supersedes the static instruction-contract strategy here.
Independent semantic review assesses workflow decisions separately; packaging
checks do not test prose semantics or prove that every Agent follows the
instructions.
