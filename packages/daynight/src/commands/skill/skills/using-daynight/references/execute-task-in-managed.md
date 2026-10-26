# Execute one task in a managed environment

Use this mode only when the worker's startup prompt explicitly declares the
`worker-managed` environment, the `using-daynight` skill, and the
`execute-task-in-managed` mode. It executes one already-claimed assignment.
Read [the handbook](handbook.md) for CLI operations and failure semantics.

## Establish the assignment

The startup prompt supplies `projectId`, `taskId`, the original `claimId`,
`worktreeId`, the actual worktree path and branch, and the execution's frozen
configuration. Use that explicit assignment throughout execution and recovery.
Task properties, the working directory, environment variables, and an ordinary
conversation request do not establish this managed context.

If a call is presented as managed but its launch declaration or assignment is
missing, incomplete, or mismatched, return waiting without task or business
writes. Do not infer replacement values or fall back to ordinary execution,
claiming, starting, or selecting another task.

The worker produces the launch prompt and decides subsequent scheduling. A new
agent started to recover the same claim receives the original mode and
assignment again. Reconnecting an existing live agent does not imply that the
startup prompt should be submitted again.

## Verify the existing execution

Read the latest complete task using the supplied project and task IDs:

```bash
daynight task show <task-id> --project <project-id> --json
```

Verify its `projectId` and `id`, `status=in_progress`, and
`properties.worker.state=active` with the supplied `claimId` and `worktreeId`.
Verify the actual working directory and Git branch match the supplied worktree.
Use the supplied frozen execution configuration without replacing it from
current defaults. If the same claim is already `completed` and the task is
`done`, report the existing completion and return without reexecuting it. Any
other state or identity mismatch leaves execution waiting; an observed claim
change stops business writes immediately.

The worker has already claimed and started this task. Do not claim it, set it
to `in_progress`, select candidates, or rerun automatic candidate qualification.
Read and apply [shared task execution](task-execution.md) for the complete task
and stage inputs, current prerequisites, authorized work, evidence, and
acceptance. A missing required input or unmet prerequisite keeps this assignment
waiting in `in_progress`; it does not authorize another task.

Before resuming interrupted work or making task writes, refresh the complete
task using the supplied project and task IDs and verify the same active claim.
Retain the original claim ID through recovery and uncertain-write
reconciliation; never substitute a claim read from the task.

## Execute within controller-owned resources

Use the supplied worktree and branch for authorized edits, commits, pushes, and
merges. Do not create, switch, or remove the system-managed worktree or branch.
Avoid merge options such as `gh pr merge --delete-branch` that may switch the
checkout or delete its branch. The worker owns resource cleanup after execution;
do not delete its worktree or close its workspace. Follow a cleanup request for
attributable temporary resources outside the worktree within its stated scope.

Use the Goal protocol for this task's required inputs and stage acceptance.
This mode never advances a Goal stage or executes a successor. The shared
execution and acceptance rules do not change that boundary.

## Complete the original claim

When [shared acceptance readiness](task-execution.md#confirm-acceptance-readiness)
is satisfied, reread the complete task, verify the same active claim, and finish
with the original claim ID and the version observed for that decision:

```bash
daynight task set-status <task-id> done --project <project-id> --claim-id <claim-id> --if-version <observed-version>
```

This is the final task mutation. Confirm `done`,
`properties.worker.state=completed`, and the original claim ID in the service
result. A refused or unconfirmed write never falls back to ordinary completion
or automatic replay: read the actual task using the supplied project and task
IDs and reconcile only the original claim. An unreadable result remains
unconfirmed; an observed claim change stops further business writes.

## Return to the controller

Return after this task completes or requires external intervention. Preserve the
assignment and waiting checkpoint when a human gate, an unmerged required PR,
missing permission, or unmet acceptance prevents completion. The worker decides
subsequent work and owns system-resource cleanup; this mode does not select a
successor or advance a Goal stage.
