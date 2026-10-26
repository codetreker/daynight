# Shared task execution

Read this reference after the selected execution mode establishes the task's
identity. It owns required inputs, authorized work, delivery, evidence, and
acceptance readiness. The execution mode owns starting or resuming the task,
its final status operation, and returning to its caller.

## Read the task and stage inputs

Read the complete task and its actual required references under
[the task content standard](task-content.md), including the solution, acceptance
criteria, and explicit task-owned confirmation/evidence location. Its Markdown
description must identify the concrete current work, responsibility, and content
sources. Complete inline content needs no primary attachment; document-owned
and mixed organization are valid when their combined contents satisfy the same
six requirements.

Resolve description-relative links and images from the current task's attachment
root; links inside a Markdown attachment use its own directory. Resolve real
shared input references using the owning task ID and description/sections,
complete paths for actual attachments, or a verified immutable repository
reference. Read source descriptions through `task show --json` and actual
attachment contents through the attachment commands; a task read does not load
attachment inventory or bytes.

For a Goal stage or delivery task, read [the Goal protocol](goal.md) and identify
its role from the actual task content and context. Apply that stage's input and
output requirements. Requirements and solution discussions start from their
stage briefs; the completed requirements, applicable UI prototype, and
architecture are outputs of the stages that produce them. Delivery tasks
require the delivered design and applicable prototype. Before implementation,
read every required architecture source listed in the delivery task's
description: the owning architecture task's inline description and applicable
sections, full paths for actual attachment documents, or verified immutable
repository references. This also applies when the architecture task is only an
indirect prerequisite. Confirm that the description's references satisfy the
Goal protocol. When a prototype is a required input, view and exercise it with
its resources. An unfinished output of the current stage is not a missing input.

## Verify prerequisites and scope

Check state, every direct prerequisite, authorized scope, and required stage
inputs. Read `dependsOn` and its `externalDependsOn` subset: ordinary edges
express same-chain prerequisites, and external marks distinguish verified
cross-chain ownership. Both kinds must be done before starting or completing
work. Classification never grants permission to execute a prerequisite, enable
automatic execution, or remove a blocker.

Missing required content, an unreadable required source, or a missing required
architecture reference or input leaves execution unready. Resolve it within
existing authorization or return the concrete issue. Do not infer requirements
from a title or silently invent acceptance criteria. Do not execute prerequisites
as an implicit expansion of the requested task.

Before analysis, questions, or proposals, establish this task's confirmed scope
and acceptance criteria and apply the [shared scope constraint](../SKILL.md#shared-constraints)
to execution and discussion.

## Execute and maintain continuity

Identify [final acceptance](../SKILL.md#final-acceptance) from the task's confirmed
outcome before applying a development or PR delivery lifecycle. Read the complete
requirements and actual deliveries for the task or Goal being assessed, and
apply the shared rule to verification methods, temporary helpers, and result
ownership.

Follow the target repository's instructions for worktrees, implementation,
review, validation, and delivery. Use the task's stage-appropriate solution and
acceptance criteria, including applicable final-style prototype interactions.
Requirements discussion defines the problem without architecture decisions or
production implementation. Solution discussion keeps its draft architecture and
breakdown in its owning task. Preserve the Goal's user-confirmation gates:
completed text, a review result, or successful checks cannot replace the user's
confirmation or authorize delivery. Keep an unconfirmed discussion in progress;
a material revision after confirmation needs renewed user confirmation.

Resolve material changes to the agreed solution or acceptance within the current
authorization. Rewrite the owning artifact and affected task summaries and input
references coherently. Preserve requirements; do not silently weaken acceptance.
Descriptions remain self-contained Markdown task summaries. Preserve valid
syntax, original content, and actual resource references during full-field
updates; confirm new or replaced resources before linking them. Dependency edits
must follow the handbook's CLI replacement contract: read full D/E, retain needed
ordinary D−E and external E declarations, submit their intended complete sets
with the observed version, and read back both. Omit all dependency options for
unrelated metadata updates. Keep detailed content at its identified owner and
confirmations and evidence at their explicit task-owned location; shared inputs
remain at their verified source.

Advance only this task. Subagents collaborate on it, and waiting for CI, review,
approval, or merge remains part of it. Keep all required delivery PR URLs and
titles in the complete `properties.pullRequests` list, preserving existing
entries. Record acceptance results and necessary delivery evidence, including
merge commits, at this task's identified evidence location against the
corresponding acceptance criteria. Rewrite current evidence coherently rather
than accumulating an execution log. Keep operational progress, blockers, waiting
items, and next action in the conversation or existing execution checkpoint,
retaining the task ID and needed PR and workspace references.

## Confirm acceptance readiness

Goal requirements and solution discussion tasks use the user-confirmed material
and stage acceptance in the Goal protocol. A generic repository PR rule does not
add a PR-merge prerequisite to these Daynight discussions. If particular
repository artifacts or PR delivery are explicitly part of that discussion
task's acceptance, honor that requirement under its delivery rules.
Unconfirmed discussion material keeps its discussion task in progress.

Development tasks and design or documentation delivery tasks with PRs remain
in progress until the hosting platform confirms **every necessary delivery PR
is merged** and all stage acceptance criteria are satisfied. Code completion,
passing CI, approved review, and an open PR do not satisfy this condition. Verify
actual merge state through the host's native client or API; do not assume a
particular host.

Completion rules grant no merge, deployment, external communication, or mainline
push permission. Follow existing authorization without asking again for actions
it covers. If the user requests an open PR for review or forbids merging, deliver
the reviewable PR and preserve the waiting checkpoint. Do not enable auto-merge.
Missing permission, unavailable merge visibility, or an unmet merge check keeps
completion pending and successors blocked.

For tasks without a development or PR delivery path, use their stated stage
acceptance. For [final acceptance](../SKILL.md#final-acceptance), also apply the
shared whole-task or whole-Goal completion rule. In every case, confirm required
evidence is recorded and readable before returning to the execution mode's
completion operation. Discussion completion establishes that stage's accepted
output; it does not establish whole-Goal completion.

## Preserve waiting context

Continue CI and review waits as this task. When progress requires external
intervention, preserve the target, actual state, concrete blocker, existing work,
and next action in the checkpoint, then return the waiting result through the
selected execution mode. Do not declare completion or select other work to
bypass a wait. Preserve the task ID through recovery and waiting.
