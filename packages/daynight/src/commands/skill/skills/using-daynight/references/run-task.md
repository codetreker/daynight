# Run one task

Execute exactly one specified task ID within the user's authorized scope. Read
[the handbook](handbook.md) for CLI operations, data semantics, and failures.
This mode owns the ordinary task lifecycle. It returns without choosing a
successor, except for the explicit user-directed requirements-to-solution
transition under [the Goal protocol](goal.md).

## Establish the task

Read the complete task with `daynight task show <task-id> --json`. Preserve the
requested task ID through recovery and waiting. Read and apply
[shared task execution](task-execution.md) for its required inputs,
prerequisites, confirmed scope, work, evidence, and acceptance.

An explicitly user-selected task may use this execution path regardless of
`allowAgents` or platform compatibility. These conditions gate automatic worker
selection, not an explicit task assignment. They do not remove dependencies,
stage inputs, or execution and delivery authorization. This mode does not select
candidates or automatically advance a fixed task queue.

Creation leaves a task `todo` and does not execute it. An explicit request to
start the current Goal discussion, or the user-directed transition that starts
solution discussion, authorizes entering `in_progress` for that discussion under
the Goal protocol; registration alone does not. Existing execution authorization
remains limited to its stated scope. Task status never expands implementation
or delivery authorization.

## Start or resume the task

For ready `todo`, begin only when dependencies are done, required stage inputs
are complete, and the work is authorized. Use
`task set-status <task-id> in_progress --if-version <observed-version>` with the
exact version observed for that decision and confirm `in_progress` before
starting. A stale version or changed prerequisite requires rereading and
reconsidering, with no automatic mutation retry.

For `in_progress`, recover existing work and coordinate using the project's
established mechanisms; the state is not an assignee lock or lease. A task
already `done` is reported as such unless reopening is within the explicit
requested scope. An authorized reopening uses the same versioned status setter
and dependency protection.

Perform the authorized work and establish acceptance readiness under
[shared task execution](task-execution.md). Starting a task is not evidence that
its delivery or acceptance is complete.

## Complete or return waiting

When all task acceptance and delivery conditions are satisfied and its evidence
is readable, reread the complete in-progress task and use
`task set-status <task-id> done --if-version <observed-version>` with its exact
observed version. Only service confirmation establishes the status update;
reconcile uncertain results before reporting success. Do not replay an
unconfirmed mutation automatically.

For Goal discussions, completion follows the confirmation gates and accepted
materials in the Goal protocol. After requirements completion is confirmed, an
explicit user direction can start the specified solution discussion under that
protocol. It grants no automatic successor selection or delivery authorization.
Whole-Goal acceptance follows the Goal protocol.

Otherwise return after this task completes or needs external intervention.
Unstarted work stays `todo`; active work stays `in_progress`. Keep the target and
waiting checkpoint when necessary PR merges, human confirmation, permission, or
acceptance remain pending; do not select another task to bypass the wait.
