# Task handoff

Use for a task or fixed group of tasks that the user explicitly requests to hand off: review content, enable automatic execution permission after it passes, then return.
See [authorization and scope](authorization.md) for boundaries; handoff does not start execution in this session or change status, dependencies, or platform.

## Content review

Read the project and complete task, preserving the exact version, status, permission, platform, dependencies, and worker records.
Read actually required sources under the [task content standard](task-content.md), checking definitions, stage requirements, producer and consumer contracts, and the [Goal architecture index](goal.md#register-the-delivery-breakdown).

For todo tasks with permission false, organize confirmed content within existing authorization; missing decisions prevent approval, and material changes require user confirmation.
Incomplete predecessor tasks need not block handoff when existing designs and interfaces sufficiently define the work, but do not claim that future outputs are already readable.
Tasks with permission already true may be selected at any time; review them read-only, without assuming execution is paused.

## Act on observed state

| State | Action |
| --- | --- |
| todo, permission false, review passed | Enable permission using the exact version on which the final review decision was based, then reconcile. Real dependency blockers may remain. |
| todo, permission false, review failed | Keep permission false and report specific gaps. |
| todo, permission true | Review read-only; do not rewrite the same value as a review marker. |
| in_progress, permission false | Report that permission is locked; do not change status to bypass it. |
| in_progress, permission true | Review read-only and report execution status; review does not pause, stop, release, or withdraw execution. |
| done | Report that it is complete and needs no handoff; do not reopen or change permission. This is handoff policy, not an API restriction. |

Preserve ownership and history for active or released workers.
New claims, workspaces, or native sessions for released tasks require an authorized administrative decision; enabling permission does not restore old execution or deleted resources.

## Update and reconcile

1. Finish authorized content organization, read back and compare required mutable sources again, not just metadata.
2. Use `task update` to enable `allowAgents` under [write safety](write-safety.md); write the final description in the same operation if needed, omitting unrelated options.
3. Check the response and read back the complete task and required sources.
   A worker may claim the task immediately after permission is enabled; a higher final version or a transition to in-progress with a worker is not a failure and must not trigger a retry.

If review fails or source verification fails after the update, report the actual permission and that scheduling may still occur; do not claim successful handoff or automatically revoke permission.
Revocation or stopping execution requires separately defined scope and the administrative workflow.
Without a confirmed response, report only actual observations, without attributing the change to this operation.

## Report and return

Before reporting, read back the complete task and reassess changes that affect the review.
For each task, report the review conclusion, changes or gaps, observed version, permission, status, dependency blockers, and applicable worker ownership; distinguish confirmed updates, uncertain writes, and read-only review.

Handle each task in a fixed group individually; one passing does not mean the others passed.
Permission true is neither permanent proof of review nor proof that execution has started or finished.
Return without selecting or starting work.
