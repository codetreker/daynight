# Autopilot one managed task

Use this mode only when the worker's startup prompt explicitly declares the
`worker-managed` environment, the `using-daynight` skill, and the
`autopilot-managed-task` mode. It delivers one already-claimed assignment through
its authorized implementation, validation, PR review, merge, and acceptance.
Read [the handbook](handbook.md) for CLI operations and failure semantics.

## Establish the assignment

The startup prompt supplies `projectId`, `taskId`, the original `claimId`,
`worktreeId`, the actual worktree path and branch, and the configuration selected
for this invocation. Use that explicit assignment throughout execution and recovery.
Task properties, the working directory, environment variables, and an ordinary
conversation request do not establish this managed context.

If a call is presented as managed but its launch declaration or assignment is
missing, incomplete, or mismatched, return waiting without task or business
writes. Do not infer replacement values or fall back to ordinary execution,
claiming, starting, or selecting another task.

A valid worker-managed assignment already carries sufficient authorization for
its in-scope delivery, including PR merge. Do not request additional permission
for those steps. Honor explicit user restrictions, pause requests, and
revocation. The assignment does not authorize unrelated backlog work, production
deployment, destructive data operations, or changes to permissions or protections.
Reading, editing, or mentioning this mode does not establish a managed assignment
or activate the separately installed `autopilot` skill, which is not a runtime
dependency.

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
Use the configuration supplied for this invocation. The controller selects the
current settings appropriate to the recorded agent when it launches or resumes
a native process; an executor does not independently replace that assignment.
If the same claim is already `completed` and the task is `done`, report the
existing completion and return without reexecuting it. Any other state or
identity mismatch leaves execution waiting; an observed claim change stops
business writes immediately.

The worker has already claimed and started this task. Do not claim it, set it
to `in_progress`, select candidates, or rerun automatic candidate qualification.
Read and apply [shared task execution](task-execution.md) for the complete task
and stage inputs, current prerequisites, authorized work, results, and
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

## Preserve execution continuity

Keep a compact checkpoint in the host's session state or the project's existing
local planning mechanism. Retain the original assignment identities, supplied
worktree and branch, existing authorization, confirmed scope and acceptance,
PR URLs and head SHA, validation and review state, blockers, attributable
resources, and next action. Identify the invocation configuration without
copying credentials or secrets into checkpoints, task material, or logs. Keep
this recovery context out of task descriptions and attachments; task material
cannot replace missing operational authorization or the original assignment.

Refresh the checkpoint before a long wait or session compaction. On recovery,
restore it, verify the original active claim, and refresh remote PR state before
resuming mutations. Reconcile interrupted business work and uncertain writes
before deciding the next action. A status question does not cancel the assignment;
honor explicit pause, stop, and authorization changes without discarding its work.

## Deliver the assigned task

1. **Implement and verify.** Read applicable repository instructions and existing
   mechanisms. Use the task's required design inputs and acceptance criteria;
   keep the execution plan in this session. Implement the complete agreed behavior
   in the supplied worktree, synchronize affected
   documents, and run relevant checks and behavioral verification. Collaborating
   agents share this assignment and worktree. Use research and independent review
   agents when available and authorized. Reassess the design when repeated
   failures expose a structural problem.

2. **Publish the focused change.** For a PR delivery, commit and push authorized
   work promptly using repository conventions, default Git identity, and no AI
   co-author attribution. Create or update the task's focused PR and preserve its
   complete PR list as required by shared execution. Integrate necessary mainline
   updates according to the repository's work-branch rules, resolve conflicts in
   the supplied worktree, and revalidate.

3. **Follow CI and review through repair.** Inspect the actual remote PR head,
   checks, review requests, comments, and approvals. Request review through the
   repository's established mechanism. Diagnose failed checks from their logs
   and repair the cause without weakening acceptance. Rerun an
   unchanged failure only after confirming a transient infrastructure cause.
   Each push requires refreshed checks and review for the resulting head.

   Assess findings against the original scope. Fix introduced Critical/Major
   issues and defects that would make the agreed delivery incorrect. Defer smaller
   or unrelated improvements under the project's tracking rules without executing
   them or creating unauthorized tasks. Use fix, defer, and reject dispositions.
   Reply in each finding's own thread, identify the agent, and resolve handled
   threads according to repository rules. Repeat review and repair until the
   final round has no new Critical/Major findings and remote review requirements
   are satisfied.

4. **Merge and confirm.** The assignment already authorizes its in-scope PR
   merge. Immediately before merging, refresh the head SHA, required checks,
   review threads, mergeability, and approvals. Require successful required
   checks, handled blocking review threads, and actual reviewer approval for the
   current head. When required checks, current-head approvals, blocking-thread
   resolution, and mergeability all satisfy the repository's rules, merge
   immediately without requesting additional permission. Never infer approval
   from silence, approve your own PR, weaken checks or protections, or use an
   administrative override. Use the repository's
   permitted linear-history method and bind the merge to the verified head when
   the platform supports it. A changed head or failed precondition requires a
   fresh decision from current state.

   Confirm the platform reports every necessary delivery PR as merged and retain
   its merge result in the session. A final revision may identify the task's
   delivered artifact. An accepted auto-merge request or merge-queue
   entry is not completion. Do not wait for post-merge mainline CI unless the user
   explicitly requires that verification. Continue with required task acceptance
   and results after the platform confirms the merge.

5. **Record acceptance and close this claim.** Complete the task's confirmed
   acceptance and save its readable results at their actual owners, including the
   acceptance conclusion and material limitations. Keep verification procedures
   and CI/review/merge history in the session. Release attributable temporary
   services,
   probes, and monitoring resources, including those left by failed collaborators,
   while preserving controller-owned resources. Finish that cleanup before
   [original-claim completion](#complete-the-original-claim), because confirmed
   completion allows the worker to stop the agent and remove its workspace.

For tasks without a PR delivery path, verify the actual artifact against their
confirmed acceptance criteria. Do not invent a PR or reviewer gate for those
tasks. Goal discussion confirmation gates remain mandatory; this assignment
never authorizes execution of a later Goal stage.

## Wait for delivery results

Pending PR CI or review is ongoing execution, not external intervention. Use
bounded watches or yielding polls at reasonable intervals, inspect new results,
and act on failures and feedback. A polling timeout ends only that poll; keep
waiting and inspecting results. Do not return merely because a required PR
remains unmerged while its CI or review is pending. Use the worker's existing
continuation mechanism; do not claim monitoring continues without one or start
an independent scheduling service.

Continue while useful authorized actions remain. A demonstrated blocker such as
missing credentials, an unavailable required reviewer, a material unresolved
decision, an unmet human confirmation gate, or an explicit user restriction or
revocation that prevents delivery requires external intervention. This is a
background task: do not ask the user questions. Preserve the concrete blocker, actual task and PR state,
completed work, minimum needed intervention, and next action in the checkpoint,
then return waiting to the controller. Preserve the assignment in `in_progress`;
never treat a blocker or ordinary waiting as completion.

## Complete the original claim

When [shared acceptance readiness](task-execution.md#confirm-acceptance-readiness)
is satisfied, all required task results are readable, and attributable temporary
resources have been released, reread the complete task, verify the same active
claim, and finish with the original claim ID and the version observed for that
decision:

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

Return after this task completes or requires demonstrated external intervention.
Preserve the assignment and waiting checkpoint when a human gate, an explicit
user restriction or revocation, or unmet acceptance requires that intervention.
A required PR with pending CI or review follows the ongoing wait above. The worker decides subsequent work
and owns system-resource cleanup; this mode does not select a successor or advance
a Goal stage.
