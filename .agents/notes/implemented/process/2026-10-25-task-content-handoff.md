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

## Decision

The public `using-daynight` bundle has a `handoff <task-id>` mode and one shared
`references/task-content.md` standard. The standard covers objective and
requirements, scope and deliverables, solution and design, input/output contracts,
acceptance and verification, and references. The description identifies the
current task, its responsibility and readable sources. Body content, required
referenced documents and mixed organization meet the same sufficiency test; a
complete description needs no primary attachment. Each content item has one
owner, and confirmation, acceptance conclusions and delivery evidence have an
explicit location in the current task's body or attachments.

This partially replaces the mandatory primary-attachment storage rules in the
[mode decision](../architecture/2026-10-21-using-daynight-modes.md),
[Goal brief decision](2026-10-22-goal-workflow-design.md),
[Markdown description decision](../architecture/2026-10-22-task-description-markdown.md)
and [tracking/review decision](2026-10-24-daynight-tracking-and-design-review.md).
The original split kept stable plans distinct from transient execution progress
and prevented several competing copies. Single content ownership and separate
execution checkpoints retain that rationale while allowing complete descriptions.
The [user-confirmed Goal discussion decision](2026-10-24-user-confirmed-goal-discussions.md)
continues to own stage gates. Shared inputs remain with their actual owners, and
every Goal delivery description directly lists the architecture task identity and
all required architecture document paths, including indirect successors.

Handoff requires the user's explicit authorization for its designated tasks.
It reads actual task content and necessary further references, checks the six
items for the current stage, and verifies applicable upstream/downstream contracts.
Known, already-confirmed information can organize a not-yet-enabled todo;
missing decisions remain concrete blockers. A blocked todo may be handed off when
its design and interfaces are sufficient, while its dependencies still prevent
execution. Only after review does an exact-observed-version update enable
`allowAgents`; creation, breakdown, automatic discovery and execution never
supply that authorization themselves.

Already-enabled tasks receive a read-only re-audit. A failed re-audit preserves
permission and explicitly reports that scheduling exposure or execution remains;
revocation or stopping requires its own authorization and existing control flow.
Running-task permission locks and active/released worker continuity remain in
force. The mode's done policy reports that no handoff is needed without rewriting
history. Handoff returns after review and result reconciliation; it does not start
run-task/autopilot or add execution and delivery authority.

Task versions protect task metadata, not independent attachment or cross-task
writes. Required mutable sources are checked before enabling and again at
execution; a changed source triggers review of the affected content. This is a
best-effort content check, not an atomic snapshot or a permanent certificate.
Conflicts require a fresh decision, uncertain writes are reconciled by reading,
and unreadable results remain unconfirmed. Immediate worker claims may produce a
higher final version or in_progress state. Reports use actual observations and
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
simple complete assignments. Content sufficiency and a designated evidence
owner preserve the useful separation without imposing that file.

**Copy complete shared requirements and designs into every task.** Each task
would be independently readable, but changes would create competing versions and
unclear owners. Accurate source identity, applicable sections and actual reads
provide the required context while preserving a single shared owner.

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

One standard controls creation, Goal breakdown, handoff and execution, including
stage-specific inputs and outputs. This removes the primary-file gate without
weakening current-stage content, real dependencies, Goal confirmation or direct
architecture-source indexing. Task evidence remains findable even when all
requirements and design are in the description.

The flag permits automatic selection but does not certify future document
versions, pause scheduling or prove execution. Existing true tasks are not
rewritten in bulk. A stricter certified-content guarantee would require an
explicit server/reference redesign; leaving the flag without certificate semantics
keeps that later change visible rather than embedding a false guarantee.

Static instruction contracts, resource copying and isolated installation establish
published content and files. Independent semantic scenarios assess the workflow's
decisions separately; neither proves that every Agent follows the instructions.
