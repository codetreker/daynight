# Goal protocol

Read this reference when starting or registering a Goal, discussing one of its
stages, or advancing its authorized scope. Use [create-task](create-task.md) for
registration, [the task content standard](task-content.md) for the shared six
content requirements, [shared task execution](task-execution.md) for input,
delivery, and acceptance rules, and [the handbook](handbook.md) for CLI semantics.
The selected execution mode owns task lifecycle and return behavior. A Goal uses existing tasks,
attachments, complete `dependsOn` relationships, their `externalDependsOn`
classification, and PR properties. It adds no resource, command, or status.

## Identify the current discussion

Use a Goal when a concrete outcome needs requirements discussion, solution or
architecture discussion, and actual delivery work. Independently understandable
features, bug fixes, architecture/design assignments, and real breakdown items
are tasks. Agent-generated commands, file reads, and routine checks stay in the
owning task's execution plan.

Permission to create a Goal covers its requirements discussion, the later solution
discussion, and the confirmed in-scope delivery breakdown. Create each only at
its stage below. Reuse suitable existing tasks after reading their full problem,
scope, materials, acceptance, and actual context; a title alone is not identity.
An explicit user or applicable repository tracking/review instruction supplies
standing creation permission within the confirmed scope. It grants no unrelated
work, implementation, external communication, deployment, merge, or mainline push
permission.

A request to start a Goal discussion authorizes creating and starting
that discussion task so it becomes `in_progress`. A registration-only request
creates only the current discussion task in `todo` and returns without execution.
Goal registration alone does not supply discussion-start or delivery execution
authorization.

## Start requirements discussion

Create or reuse only the requirements discussion task, titled `[Goal]<outcome>`.
The marker is followed directly by the outcome. Do not create an architecture
placeholder or delivery tasks at this point. Give the task a self-contained Markdown description
for the known problem, intended outcome, scope, constraints, open
questions, and observable completion conditions. The description and actual
references provide this discussion's solution, acceptance criteria, confirmation
gate, and task-owned evidence location under the shared content standard;
finished requirements and prototypes are outputs, not prerequisites to starting.

Each task starts in `todo`. For an explicit discussion-start request, read its
current materials and exact version, use `task set-status <task-id> in_progress`
with the version observed for that decision and confirm `in_progress`.
All direct prerequisites must be done. Preserve real external blockers rather
than removing dependencies to make a discussion ready. An already in-progress
task is resumed after checking its actual work and context.

Discuss requirements with the user: the whole problem, desired behavior, scope,
constraints, exclusions, and whole-Goal acceptance. Keep current material and open
questions in this task's description or attachments. The description remains a
task-specific brief and source entrypoint; detailed requirements have one owner,
and confirmation, validation, and evidence stay at an identified task-owned location. Before requesting user review, save the complete current material,
read it back, and provide the task and resource reference.

For a UI Goal, produce a final-style interactive frontend-only prototype with
working relative resources and relevant populated, empty, loading, failure,
disabled, long-content, and narrow-screen states. View and exercise it. Prototype
code is a requirements artifact; this discussion does not implement production
code or decide the architecture.

## Confirm requirements and start solution discussion

Keep the requirements task `in_progress` until the user explicitly confirms the
current requirements and directs the next discussion, for example, "Requirements
are settled; move to architecture discussion." Agent confidence, completed text,
a review result, or elapsed time does not satisfy this gate.

Record the user's confirmation with the accepted material in the owning task and
verify it is readable. A material revision after confirmation requires renewed
user confirmation before advancement. When the discussion's acceptance is met,
reread the task, use `task set-status <task-id> done` with its observed version, and confirm done.
Do not create the solution discussion until that completion is confirmed; reconcile
an uncertain completion before another mutation.

Then create or reuse the solution discussion task, with a purpose-specific title
such as `Architecture discussion: <outcome>`, and an ordinary prerequisite on the
completed requirements task. The user's direction to start this discussion
provides its scoped execution authorization. Prepare its stage brief,
read its current version, set in_progress through the same lifecycle, and
confirm `in_progress`. This user-directed transition is available to ordinary
execution only; it does not authorize selection of another unrelated task.

## Execute the appropriate stage

During solution discussion, consume the confirmed requirements and applicable
prototype. Discuss how to achieve the outcome: responsibilities, data and control
flow, interfaces, error behavior, key decisions, verification, and the proposed
breakdown. The solution task owns the current architecture, proposal, and draft
breakdown. Keep discussion material accessible in its description or attachments,
verify it before user review, and synchronize revisions and review decisions.
Do not register delivery subtasks before the user confirms the current solution.

A discussion task completes from user-confirmed Daynight material and its stated
stage acceptance. Repository document/code delivery still follows normal PR and
merge rules, but a generic repository PR rule does not add a merge prerequisite
to a Daynight discussion. If the user explicitly makes particular repository
artifacts or PR delivery part of that discussion's acceptance, honor that
requirement and its delivery permissions. An unresolved user review keeps the
current discussion `in_progress`. Successful CI or a design review cannot replace
the user's confirmation.

After explicit user confirmation of the current solution, record that confirmation
with the accepted material and register the delivery breakdown below. Complete
the solution discussion only after the accepted solution and actual registered delivery tasks,
their required materials, and their dependencies are read back
and verified. Use `task set-status <task-id> done` with the observed version and confirm done.
Completion satisfies dependencies and grants no delivery execution permission. Completing
either discussion does not establish whole-Goal completion.

## Register the confirmed delivery breakdown

Only after user solution confirmation, create or reuse the concrete delivery tasks
needed for the agreed outcome. Each description and its actual references must
satisfy the six-item content standard, including task-specific responsibility,
input/output contracts, observable acceptance, verification, and evidence ownership. Include independently scoped acceptance work when it
has its own outcome. A [final-acceptance](../SKILL.md#final-acceptance) brief
identifies the original whole-Goal requirements and confirmed changes, and assesses
the combined delivery under the shared rule. Do not turn agent-generated execution
steps into tasks. The combined scope must cover the confirmed Goal, rather than a
vague placeholder.

Create new delivery tasks in `todo`. Solution confirmation authorizes the
confirmed breakdown's registration, not implementation, automatic-execution
permission, publishing, deployment, or merge. Apply any
separate explicit authorization only within its stated scope. New tasks have
`allowAgents=false`; registration does not enable it. Only a separately explicit
[handoff](handoff.md) may review and enable permission; it does not supply delivery
execution authorization or advance the discussion gate.

Use ordinary dependencies for real within-Goal prerequisites. Every delivery root
without another ordinary implementation prerequisite depends directly on the
solution discussion, so each delivery path includes confirmed design completion.
Mark verified prerequisites owned by another same-project chain as external;
external prerequisites remain real blockers and do not replace that ordinary
design gate. Apply [the handbook's dependency reduction rule](handbook.md#dependency-reduction)
before registering the breakdown: successors inherit prerequisites through
retained paths and do not repeat those direct edges. Preserve the complete
necessary relationship sets under the handbook's CLI replacement semantics.
Do not create dependencies merely to group cards.

Upload needed task-owned resources when their content uses attachments. Keep
shared requirements with the requirements task and the solution and breakdown with the
solution task. Consumers reference the owning task ID and the source description
with applicable sections for inline content, full paths for actual attachments,
or immutable repository sources. Use `task show --json` for source descriptions
and the attachment commands for actual attachment contents. Every delivery
task's description must directly list the architecture task ID and all required
architecture source locations: description and applicable sections for inline
design, full paths under the source task for each actual required attachment
document, and verified immutable repository references for repository documents.
Do not fabricate an attachment path or copy or relocate inline architecture to
fit this index. This applies to indirect successors as well as delivery roots;
a reference only in another task or inside an attachment is insufficient.
These input references do not add execution dependencies or duplicate shared
documents.

Read back every task, required attachment, shared input, and dependency before
reporting the breakdown registered. Verify required paths and the absence of
redundant direct edges under the handbook's reduction rule. Check each delivery
task's description, including indirect successors, for the architecture task ID and every required
document reference; confirm that each reference resolves to the intended readable
content. Keep the solution discussion `in_progress` when registration is incomplete.
If the accepted solution materially changes, obtain renewed user confirmation
before registering or advancing the changed work.

For an illustrative `architecture → A → B` chain, A delivers the upload API and B
delivers its retry controls. B depends only on A, inherits the architecture
prerequisite through A, and directly names the architecture inputs in its
description. The following task ID and paths are hypothetical;
replace them with verified sources when registering real work:

```markdown
## Objective and scope
Implement upload retry controls using the delivered upload API. Preserve the
selected files and show the confirmed error-specific retry actions.

## Completion conditions
Retryable failures offer retry; permanent failures explain the required action.
Successful retry clears the error without losing the selected files.

## Architecture inputs
Architecture task: `11111111-1111-4111-8111-111111111111`.
Read these attachments from that task before implementation:

- `design/architecture.md`: upload flow and component responsibilities.
- `design/upload-errors.md`: error classification and retry behavior.

## Task plan
This task's `plan.md` owns its implementation plan and full acceptance criteria.
```

When the shared architecture is inline, the architecture inputs instead identify
the same source task ID and its description sections, such as "Upload flow" and
"Error classification". Read those sections with `task show --json`; list full
paths only for actual attachment documents that are also required.

## Preserve ownership and recover partial registration

Stage briefs describe the work to produce the stage's outputs; they do not claim
unfinished results exist. Every stage and delivery task provides a task-specific
Markdown brief and the complete applicable content, directly or through verified
references. Complete inline content needs no primary attachment. Identify each
task's own confirmation and evidence location. Keep shared inputs at their actual
owner. Do not distribute a duplicate whole packet to every task. An independently
needed snapshot records its purpose, original source, and source revision or
content identity. Existing attachment reads support these references; do not
invent a URL scheme, cross-task relative links, or fixed service host.

Creation, uploads, metadata changes, and lifecycle actions are independent writes.
Retain confirmed IDs and resume missing operations after partial success. Read
actual task fields and attachment contents before retrying an uncertain write;
a matching title or lost response does not establish success or failure. If the
identity cannot be established uniquely, preserve the failure and information
needed to reconcile it rather than creating a duplicate chain.

Bind metadata updates and status changes to the exact version
observed for that decision. Attachment bytes have independent concurrency and
must be verified separately; task versions cannot prove the reviewed content is
unchanged. Generic updates cannot write status. A version conflict requires a
new decision. Readiness and `in_progress` provide no ownership lock or lease.

## Advance and accept the whole Goal

Ordinary execution processes one specified task and returns after completion or
external wait. A user-directed requirements-to-solution transition follows the
confirmation protocol above and the ordinary execution mode. Neither discussion
completion nor breakdown registration starts delivery or selects later work.
Existing execution authorization for a fixed Goal scope remains within that
scope, but does not make the skill discover or continuously select successors.
CI, review, and merge waits stay with the current delivery task. Other execution
modes preserve their own return boundary when reading this stage protocol.

Delivery tasks satisfy [shared acceptance readiness](task-execution.md#confirm-acceptance-readiness)
and complete through their selected execution mode: accepted outcomes, required
review, all necessary authorized PR merges, and readable evidence. To report the
whole Goal complete, inspect the full confirmed delivery scope, every delivery
task's completion, all required delivery PR merges, and the original whole-Goal
requirements with their confirmed changes. Apply
[Final acceptance](../SKILL.md#final-acceptance) to the combined delivery and its
evidence; completing or passing temporary helpers does not establish that the
Goal is complete.

The requirements task being done means only that requirements discussion is
complete. The solution task being done means the confirmed solution and verified
breakdown are delivered. An empty ready page or a single delivery result proves
neither the whole outcome nor completion of all its work.
