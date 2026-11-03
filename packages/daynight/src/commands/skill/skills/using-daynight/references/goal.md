# Goal protocol

A Goal expresses a multi-stage objective through ordinary tasks, attachments, dependencies, and PR properties without adding resources, commands, or statuses.
Follow [create task](create-task.md) for creation, the [task content standard](task-content.md) for material, and [authorization and scope](authorization.md) for operational permissions.
This file covers only stage progression and Goal-specific requirements.

## Stages and confirmation

| Stage | Starting content | Results and completion gate |
| --- | --- | --- |
| Requirements discussion | Known problem, expected outcome, scope, constraints, open questions, and completion conditions | A complete uploaded and read-back `spec.md` and applicable interactive prototypes; the user explicitly confirms the current spec and directs progression to solution discussion; the required solution task has been registered and verified. |
| Solution discussion | The confirmed requirements task’s `spec.md` and applicable prototypes, design questions, and completion conditions | Architecture, key decisions, and breakdown; the user confirms the solution, and actual delivery tasks have been registered and read back. |
| Delivery tasks | Defined responsibilities, required designs and prototypes, contracts, and acceptance criteria | Actual results meeting the [shared delivery conditions](task-execution.md#completion-conditions). |
| Final acceptance | Complete confirmed requirements, actual combined results, and acceptance criteria | A conclusion for the whole Goal under [final acceptance](final-acceptance.md). |

Discussions remain `in_progress` without user confirmation; completed prose, agent confidence, successful reviews, and passing CI cannot replace confirmation.
Substantive revisions after confirmation require renewed confirmation.
Discussion acceptance does not automatically add repository PR merge requirements; only repository artifacts or PR delivery explicitly included in that task are subject to the corresponding delivery conditions.

## From requirements to solution

First create or reuse the single requirements-discussion task, titled `[Goal]<outcome>`.
At initial registration, create only the requirements stage; do not pre-create architecture placeholders or delivery items.
Return for registration-only requests; when explicitly asked to start the discussion, start or resume through [ordinary execution](run-task.md).

Requirements discussion defines the problem and behavior without deciding architecture or implementing production code.
Its complete spec is a result of this stage, not a prerequisite for registering or starting the Goal.

### Complete requirements spec

The requirements task must own a complete, independently readable Markdown attachment at `spec.md`, in addition to its description.
Keep the description self-contained about the objective, responsibility, scope, deliverables, completion conditions, and actual spec location; do not duplicate the full spec there.
A complete description or a repository link does not replace this required attachment.

The spec covers the background and problem, goals and non-goals, applicable actors and scenarios, required behavior and boundaries, constraints, success and failure behavior, and observable whole-Goal acceptance criteria.
Address permissions, data lifecycle, platforms, and nonfunctional requirements when applicable to the objective, without empty templates or invented requirements.
Resolve open questions that affect required scope, behavior, or acceptance before confirmation; leave architecture choices to solution discussion.
For UI Goals, produce the applicable final-style interactive prototypes under the [prototype requirements for task creation](create-task.md#prepare-content), and reference their uploaded resources from the spec.

Before requesting user confirmation, upload the complete current spec and necessary resources, read back their actual contents, verify the references, and provide the requirements task ID and attachment paths.
Confirmation applies to that current readable spec and applicable prototypes.
Missing, incomplete, failed, or unreadable uploads cannot pass the requirements gate.
Coherently update the spec and affected description, prototypes, and references after substantive requirement changes, and obtain renewed confirmation before progression.
Attachments do not change the task version; follow [write safety](write-safety.md#attachments-and-multi-step-operations) rather than treating an unchanged version as proof that confirmation remains valid.

### Register the next discussion before completion

After the user confirms the current spec and directs progression to solution discussion, create or reuse the solution-discussion task while the requirements task remains `in_progress`.
Use the requirements task as an ordinary prerequisite; the solution task stays `todo` and blocked until that prerequisite is done.
Its description must directly identify the requirements task ID, the full `spec.md` attachment path, and applicable prototype resources; read those actual sources and prepare the stage brief.
Keep the shared spec in its owning requirements task.

Read back the solution task, its required sources, and the actual dependency graph before completing the requirements task under the [shared completion conditions](task-execution.md#completion-conditions).
If registration or verification fails or its result is uncertain, keep the requirements task `in_progress`, reconcile actual resources, and resume with the confirmed IDs under [write safety](write-safety.md).
Once the successor is verified and all requirements-stage conditions are met, complete the requirements task and verify it is done.
Ordinary execution may then start the solution discussion at the user's explicit direction; managed execution completes only the original assignment and returns to the controller without starting the successor.
If completion is uncertain, reconcile it before starting the solution task.

Solution discussion explains responsibilities, data flow, control flow, interfaces, error behavior, key decisions, verification, and the proposed breakdown.
Keep the current solution and breakdown in this stage's own material; do not register delivery items before confirmation.
After the user confirms the solution, perform the registration checks below before completing the solution task.

## Register the delivery breakdown

The breakdown must collectively cover the confirmed Goal, with independent responsibilities, inputs, deliverables, and observable acceptance criteria for each task.
Include acceptance in the breakdown when it has an independent result; do not substitute vague placeholders or session execution steps for actual work.

Every root delivery task without another ordinary implementation prerequisite must directly depend on the solution task through an ordinary dependency, so all delivery paths inherit the confirmed design's completion conditions.
Verify cross-chain dependencies and follow [classification and reduction](task-management.md#dependency-classification); external prerequisites cannot replace ordinary design prerequisites.

**Every delivery task's description must directly identify the architecture task ID and all required architecture source locations, including for indirect successors.**
Identify the description and applicable sections for inline architecture, list full paths for actual attachments, and retain the owning task ID and verified immutable references for repository sources.
An index only in an upstream task or inside an attachment is insufficient.
Read actual sources under the content standard; do not invent attachments or copy the full set of shared material.

For example, in `architecture -> A -> B`, B declares only A as a direct dependency and inherits the architecture prerequisite through A, but B's description still directly lists the required architecture sources.
Source indexes do not create additional execution dependencies.

Read back every delivery task and its required inputs, checking responsibility coverage, architecture indexes, and source readability.
Check dependencies through [post-change verification](task-management.md#verify-dependency-changes).
Keep the solution task in progress while gaps remain; recover partial registration under [write safety](write-safety.md).
Registration and solution completion do not start delivery or enable automatic-execution permission.

## Whole-Goal completion

Complete each task through the selected execution workflow; reading the Goal protocol does not change the return boundaries of ordinary or managed workflows.
A single done task, an empty ready page, completed requirements, or a completed solution does not mean the whole Goal has been delivered.

Before reporting the whole Goal complete, verify the full confirmed scope, every delivery result, and the actual merge status of all required PRs, and perform final acceptance on the combined results.
Discussion confirmation, registration, and prerequisite completion do not automatically select successor work.
