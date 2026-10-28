# Agent Note: Separate task content from session execution

Status: implemented

## Problem

A complete task must remain understandable outside the conversation that created
it. Requiring every task to describe its solution, implementation plan, validation
methods, confirmations and delivery evidence also imports how one session intends
to work. A generic task-specific filter cannot resolve that conflict while the
required fields and examples continue to ask for session plans. Moving those
plans into an attachment does not make them task information. Removing all
method-shaped prose would create the opposite failure: upstream architecture,
design deliverables and requested runbooks could disappear from real work.

## Decision

The public skill's `references/task-content.md` owns one content boundary: tasks
describe what must be achieved and delivered; sessions hold how the task is
executed or discussed. The rule applies to descriptions, attachments and referenced
task material. A filename or storage location does not determine ownership.

Task definition covers objective and requirements, scope and constraints, required
inputs and sources, deliverables and actual exchange contracts, and acceptance
criteria. Current requirements or design drafts, final artifacts, acceptance
conclusions and material result limitations are stored as they are produced.
Creation does not require placeholder results or a universal solution,
implementation plan, verification procedure, confirmation record or evidence
location. Required upstream design is an input; a design-producing task delivers
its design. A user-requested migration plan, runbook or testing strategy can
contain methods because that material is the agreed artifact, not the executor's
checkpoint.

Execution and discussion plans, steps, tool choices, collaboration, operational
authorization, review/CI/merge history, progress, blockers and recovery context
remain in the session or its existing local checkpoint. An accepted requirement
or design and its effective state remain task content; the confirmation exchange
and permission to perform an operation do not. Necessary source revisions can
identify actual results, and independent acceptance conclusions retain supporting
observations and limitations without accumulating execution logs. Structured
status, dependencies, PR references, permission, platform and worker fields keep
their existing service meanings.

This partially supersedes the [task-content and handoff decision](2026-10-25-task-content-handoff.md)'s
six mandatory content categories and generic task-local confirmation/evidence
requirement. Its isolated-reader rationale, single content owner, inline/reference/
mixed organization, verified shared inputs, Goal architecture index and handoff
concurrency safeguards remain. The [Goal stage decision](2026-10-24-user-confirmed-goal-discussions.md)
retains human confirmation and stage transitions. All operation authorization,
exact-version, dependency, claim and delivery gates remain with the existing
mode protocols; task material does not recreate missing authorization.

The [skill requirements](../../../../docs/spec/daynight-agent-skill.md) and
[design](../../../../docs/design/daynight-agent-skill.md) own the current behavior
and responsibilities. Canonical skill resources and their existing build,
installation and update flows distribute this rule without a new API, storage
format, session service or runtime entrypoint. Existing task material is not
rewritten in bulk; new or authorized revisions follow the boundary.

## Alternatives

**Strengthen only the generic task-specific sentence.** This keeps the edit
central, but leaves required solution, method and evidence fields asking for the
same session information the sentence is supposed to exclude. The conflict must
be removed from content sufficiency and examples as well.

**Keep all six categories and add exclusions in each mode.** This preserves the
old labels but forces every reader to distinguish several meanings of solution,
method, confirmation and evidence. A task definition and conditional artifacts
express the actual responsibility once and let modes retain operation rules.

**Exclude every document that contains methods or steps.** This avoids some
session plans but rejects real design inputs and user-requested migration plans,
runbooks and testing strategies. Classifying material by its agreed role preserves
those artifacts while excluding the session's plan for producing them.

## Consequences

Task sufficiency does not depend on an agent execution plan. Missing required
architecture, prototypes, contracts or acceptance decisions still blocks the
appropriate stage. Descriptions and attachments remain equally valid and shared
inputs keep their real owners; filename bans and mandatory primary attachments
are unnecessary.

Session continuity uses existing host state or local checkpoints. The content
boundary provides no cross-host migration or replacement for missing assignment
and authorization. Historical tasks require their own authorized changes, and
archives remain immutable. A future need for certified task snapshots or shared
session storage requires its own contract rather than copying checkpoints into
task material.

Static contracts and negative mutations check that both exclusion and preservation
obligations are shipped. Packaging and installation check resources and bytes.
Independent semantic scenarios check mixed requests, real inputs and artifacts,
operational authority, recovery and all task storage forms. Keeping a correct
sentence while adding a contradiction is a semantic case, not something existing
positive regex checks certify. Neither static nor installation checks establish
universal model compliance.
