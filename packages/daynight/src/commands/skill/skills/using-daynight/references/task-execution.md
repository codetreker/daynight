# Shared task execution

Read this file after identifying the task in both ordinary and managed execution.
It governs shared inputs, work, results, and completion conditions; the mode-specific files govern startup, final status operations, interaction, and return.
Managed execution must also meet its [complete delivery standard](autopilot-managed-task.md#complete-delivery-standard).

## Inputs and readiness

Read the complete task, actually required references, and existing results under the [task content standard](task-content.md).
For Goal tasks, also apply the [stage protocol](goal.md) and check responsibilities, stage inputs, and the architecture index.
Inspect required prototypes with their assets and actually interact with them.

Verify status and all direct prerequisites under [task management](task-management.md), and apply [authorization and scope](authorization.md).
Execution is not ready when required content or authorization is missing, sources are unreadable, or dependencies are incomplete; report the specific blocker without executing predecessor tasks to bypass it.

## Work and results

Work within the confirmed scope, design, and acceptance criteria, following the target repository's rules for worktrees, implementation, research, review, verification, and delivery.
For independent final acceptance, apply the [acceptance standard](final-acceptance.md), not inapplicable development workflows.

When authorized changes occur, coherently rewrite the actual owning material and affected references, preserving the strength of requirements and acceptance criteria; reconfirm material revisions at the corresponding confirmation points.
Follow [task management](task-management.md) and [write safety](write-safety.md) when updating fields and editing dependencies.

When creating a PR, its description must clearly explain the problem being solved and how the change addresses it.
If the PR is associated with a Daynight task, include the task's ID and title.

Save the URLs and titles of all required delivery PRs in the complete `properties.pullRequests` list with [property setting](task-management.md#properties), preserving existing entries. Save actual deliverables, current conclusions, and acceptance results in the owning task's material; keep implementation steps, CI, reviews, merge handling, and operational authorization in the session or corresponding platform under the content standard.

## Completion conditions

| Task type | Completion conditions |
| --- | --- |
| Goal discussion | The user confirms the current material, and the corresponding Goal stage requirements are met; generic PR rules cannot replace or add confirmation requirements. |
| PR delivery | The hosting platform confirms that all required delivery PRs are merged, and stage acceptance criteria are met; finished code, passing CI, approval, an open PR, or entry into a merge queue is not enough. |
| No PR delivery | Meet stage acceptance criteria and the selected mode's delivery requirements, without inventing PRs or unrelated approvals. |
| Final acceptance | Also meet the [acceptance requirements](final-acceptance.md) for the complete task or Goal. |

Verify actual merges through the hosting platform's native client or API, without assuming a specific platform.
When the user requires PRs to remain open for review or prohibits merging, deliver reviewable results and keep the task in progress, without enabling auto-merge.
Completion remains pending when permission is missing, verification is impossible, or merge conditions are unmet.

Before returning to the mode-specific file for completion operations, confirm that required deliverables and acceptance conclusions are readable.
Completing a stage establishes only that stage's results, not completion of the whole Goal.

## Waiting context

CI, review, and merge waits belong to the current task; the execution mode defines continued waiting, signaling, and return behavior.
When intervention is needed, preserve the task ID, actual status, existing work, specific blocker, PR and workspace references, existing authorization, and next step in the session checkpoint, not a task execution log.
Recover the assignment and authorization from this context, not by inferring them from task status.
Waiting neither completes the task nor permits selecting other work.
