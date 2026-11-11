# Task handoff

Use for a task or fixed group of tasks that the user explicitly requests to hand off: review content readiness and authenticated responsibility, enable automatic execution permission after both pass, then return.
See [authorization and scope](authorization.md) for boundaries; handoff does not start execution in this session or change assignment, status, dependencies, or platform.

## Content and responsibility review

To check the selected task's state and responsibility, read only that task, preserving the exact version, assignedTo, status, permission, platform, dependencies, and worker records:

```bash
daynight task show <task-id> --project <project-id> --json
```

If it is done or cancelled, report the actual terminal result and that no handoff is needed, then return without an ownership check or further task discovery. Cancelled does not prove delivery and cannot be reopened.
Read actually required sources under the [task content standard](task-content.md), checking definitions, stage requirements, and producer and consumer contracts.
For every delivery task, including standalone tasks, verify that its problem, selected solution, detailed design, implementation steps and acceptance criteria meet the [content sufficiency requirements](task-content.md#content-sufficiency) before approving its content. Missing or unresolved information in any of these areas prevents a passing handoff; do not delegate those gaps implicitly to the implementer.
For a Goal delivery task, check its [delivery brief and task boundary](goal.md#delivery-task-brief) and [architecture source index](goal.md#register-the-delivery-breakdown). Its objective, scope, implementation approach and acceptance must remain consistent with the confirmed Goal and accepted solution; a missing approach, unsuitable boundary or departure from that Goal is a content gap.
Read cited source tasks and upstream or downstream contracts only as genuinely needed to assess the selected task. Report concrete content or contract gaps; this review does not authorize repartitioning tasks or changing dependencies.
Whole-breakdown coverage follows the Goal breakdown checks; handoff does not discover additional work or reconstruct the entire Goal for a selected task.

Compare the selected task's non-null assignedTo with the current authenticated account's local user UUID, independently confirmed during [setup](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/setup-and-projects.md#setup) or in the current session. A display name, email, the task's own assignedTo or a worker record cannot establish that identity.
Do not enumerate project or account task collections to check ownership. A null or different assignment, unknown account UUID, or unreadable task prevents a passing handoff; report the actual assignment or verification error without assigning the task yourself or enabling permission. Recheck the selected task and reassess changes before the exact-version update.
CLI creation defaults to the authenticated account; existing tasks and other clients may still create unassigned or other-user tasks.

For todo tasks with permission false, complete authorized content preparation and read back the resulting material before enabling permission. Identify and resolve specific gaps within the authorized scope, obtaining confirmation for substantive decisions as required; missing decisions prevent approval, and material changes require user confirmation.
Content readiness is separate from readiness to start. Incomplete predecessor tasks need not block handoff when the selected solution, detailed design, exchange contracts and integration steps already fully define the work. Unresolved predecessor design decisions are content gaps; do not treat them or future outputs as existing inputs.
Tasks with permission already true may be selected at any time; review them read-only, without assuming execution is paused.

## Act on observed state

| State | Action |
| --- | --- |
| proposed | Report that it is not an automatic-execution candidate. Complete authorized content review, but keep status and permission unchanged; changing it to todo requires an explicit caller decision. Enabling permission alone would not make it executable. |
| todo, permission false, content and responsibility review passed | Enable permission using the exact version on which the final review decision was based, then reconcile. Real dependency blockers may remain. |
| todo, permission false, either review failed or unconfirmed | Keep assignment and permission unchanged and report specific gaps. |
| todo, permission true | Review read-only; do not rewrite the same value as a review marker. Report assignment mismatches or unconfirmed responsibility without claiming a passing handoff. |
| in_progress, permission false | Report that permission is locked; do not change status to bypass it. |
| in_progress, permission true | Review read-only and report execution status and responsibility; review does not pause, stop, release, withdraw or reassign execution. |
| done | Report that it is complete and needs no handoff; do not reopen or change assignment or permission. This is handoff policy, not an API restriction. |
| cancelled | Report cancellation and that no handoff is needed; do not restore execution, change assignment or enable permission. Cancellation is not proof of delivery. |

Preserve ownership and history for active or released workers. The responsibility check does not revoke or transfer an existing claim.
New claims, workspaces, or native sessions for released tasks require an authorized administrative decision; enabling permission does not restore old execution or deleted resources.

## Update and reconcile

1. Finish authorized content organization, read back and compare required mutable sources again, not just metadata. Confirm current authenticated responsibility against the final reviewed task and its exact version.
2. Use `task update` to enable `allowAgents` under [write safety](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/write-safety.md); write the final description in the same operation if needed, omitting unrelated options. An assignment or version change requires a fresh review decision, not a replay with a newer version.
3. Check the response and read back the complete task and required sources, including assignedTo.
   A worker may claim the task immediately after permission is enabled; a higher final version or a transition to in-progress with a worker is not a failure and must not trigger a retry.

If review fails or source or responsibility verification fails after the update, report the actual assignment and permission and that scheduling may still occur; do not claim successful handoff or automatically revoke permission.
Revocation or stopping execution requires separately defined scope and the administrative workflow.
Without a confirmed response, report only actual observations, without attributing the change to this operation.

## Report and return

Before reporting, read back the complete task and reassess changes that affect the review.
For each task, report the content and responsibility conclusions, changes or gaps, observed version, assignedTo, permission, status, dependency blockers, and applicable worker ownership; distinguish confirmed updates, uncertain writes, and read-only review.

Handle each task in a fixed group individually; one passing does not mean the others passed, and per-task handoff is not a new whole-Goal coverage conclusion.
Permission true is neither permanent proof of review nor proof that execution has started or finished.
Return without selecting or starting work.
