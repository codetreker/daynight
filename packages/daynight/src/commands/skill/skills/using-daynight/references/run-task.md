# Ordinary task execution

Use for one task explicitly specified by the user.
Apply [authorization and scope](authorization.md) first, read the complete task with `daynight task show <task-id> --json`, and verify inputs and completion conditions under [shared task execution](task-execution.md).

## Start or resume

| Observed status | Behavior |
| --- | --- |
| todo | Once ready and authorized for execution, use `task set-status` with the exact observed version to enter `in_progress`; confirm success before starting. |
| in_progress | Reconcile existing work and session context, coordinate and resume through established repository mechanisms, and do not treat status as an execution lock. |
| done | Report that it is already complete; consider reopening only when the explicit request includes it. |

An explicit ordinary assignment is not restricted by `allowAgents` or platform filtering for automatic selection; see [task management](task-management.md#metadata).
This workflow does not select candidate tasks or advance a queue automatically.

## Complete or wait

Follow the shared execution rules.
Once all completion conditions are met, reread the in-progress task, set it to done using its observed version, and confirm the service result.
Handle all changes and uncertain responses under [write safety](write-safety.md); ordinary completion does not include a worker claim.

When merging, human confirmation, authorization, or acceptance is still missing, keep the task in progress and preserve the waiting context.
Tasks not yet started remain todo.
Return when complete or when external intervention is needed, without selecting a successor; follow the [Goal protocol](goal.md) for discussion-stage transitions explicitly directed by the user.
