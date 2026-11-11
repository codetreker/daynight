# Ordinary task execution

Use for one task explicitly specified by the user.
Apply [authorization and scope](authorization.md) first, read the complete task with `daynight task show <task-id> --json`, and verify inputs and completion conditions under [shared task execution](task-execution.md).

## Start or resume

| Observed status | Behavior |
| --- | --- |
| proposed or todo | Once all direct prerequisites are done or cancelled, inputs are sufficient and execution is authorized, use `task set-status` with the exact observed version to enter `in_progress` directly; confirm success before starting. Proposed does not need an intermediate todo transition. |
| in_progress | Reconcile existing work and session context, coordinate and resume through established repository mechanisms, and do not treat status as an execution lock. |
| done | Report that it is already complete; consider reopening only when the explicit request includes it. |
| cancelled | Report the cancelled terminal result and return; do not reopen, resume or substitute a completion claim. |

An explicit ordinary assignment is not restricted by `allowAgents` or platform filtering for automatic selection; see [task management](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/tasks.md#queries).
This workflow does not select candidate tasks or advance a queue automatically.

## Complete or wait

Follow the shared execution rules, including verifying required successor registration before completion.
Once all completion conditions are met, reread the in-progress task, set it to done using its observed version, and confirm the service result.
Handle all changes and uncertain responses under [write safety](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/write-safety.md); ordinary completion does not include a worker claim.

When merging, human confirmation, authorization, or acceptance is still missing, keep the task in progress and preserve the waiting context.
Tasks not yet started retain their current proposed or todo status.
Return when complete or when external intervention is needed, without selecting a successor; follow the [Goal protocol](goal.md) for discussion-stage transitions explicitly directed by the user.
