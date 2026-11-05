# Managed task execution

Use only when the worker startup prompt explicitly selects this workflow; see [SKILL.md](../SKILL.md) for entry conditions.
This workflow sustains delivery of the single originally assigned task, without executing its predecessors, successors, or siblings.

## Preserve the assignment and read the task

Preserve the project ID, task ID, original claim ID, workspace, and native session identity supplied by the startup prompt, including through context compaction or recovery.
The worker has already started the task in the specified directory. Read the latest complete task with an explicit project:

```bash
daynight task show <task-id> --project <project-id> --json
```

Check `allowAgents` first; if false, stop execution immediately without enabling it yourself.
Confirm that the task still belongs to the original active claim; on a mismatch, stop task-related writes and report it, without acquiring a new claim.
Verify inputs, scope, and completion conditions using [shared task execution](task-execution.md).

## Complete delivery standard

| Task type | Required results |
| --- | --- |
| Research | Provide the full research report as a task attachment. |
| Design or architecture | Provide the full solution as a task attachment after multiple independent reviews, with no Critical/Major issues; attach a separate review file for remaining nonblocking issues. |
| Development | All required delivery PRs are actually merged, and task acceptance criteria are met. |
| Acceptance | Complete acceptance against the criteria, collect evidence, and upload it as task attachments. |

These requirements supplement the [shared completion conditions](task-execution.md#completion-conditions).
Task descriptions and source organization follow the [task content standard](task-content.md); inline content cannot replace attachments explicitly required by this table.
Goal confirmation points still require human confirmation; the assignment does not authorize executing other stages.

## Sustain complete delivery

A valid assignment includes the authorization needed for complete delivery of this task; see [authorization and scope](authorization.md) for the boundaries.
Keep advancing the task proactively; occasional user interaction does not authorize stopping, while explicit pauses, restrictions, and revocations still apply.
Continue while useful, authorized actions remain available.

Implement, synchronize related documents, and verify in the assigned workspace; collaborating agents share the task scope.
Use research and independent review agents when available and authorized; reassess the design when repeated failures expose structural problems.
For tasks without PR delivery, apply the complete delivery standard directly rather than inventing a PR workflow.

For PR delivery, sustain the following workflow:

1. Commit, push, and create or update focused PRs promptly under repository conventions; use the default Git identity and omit AI co-author attribution.
   Integrate necessary mainline updates, resolve conflicts, and verify in that workspace.
2. Actively monitor remote HEAD, CI, reviews, and conflicts.
   Inspect failure logs first; each failed check on the same commit may be rerun at most twice beyond its initial run, without first proving a transient infrastructure cause.
   Count retries across sessions, restarts and workflow reruns. If both retries fail, diagnose and repair the cause before further validation.
   A passing retry does not establish the root cause or relax required checks and acceptance criteria; report retries and observed results.
   Refresh checks and reviews after every push.
   Fix Critical/Major issues in the current change and defects that would make delivery incorrect; defer smaller or unrelated improvements under project rules, without creating tasks on your own.
   Respond in each thread with the fix, deferral, or reason for not adopting the finding, identify the agent, and resolve threads under repository rules.
   Continue until the final round has no new Critical/Major issues and remote review requirements are met.
3. Immediately before merging, refresh HEAD, required checks, blocking threads, mergeability, and approvals for the current HEAD.
   Once all requirements are met, merge using a linear method permitted by the repository; bind the operation to the verified HEAD when the platform supports it.
   Do not infer approval from silence, self-approve, bypass protections, or weaken checks.
   Reassess if HEAD or conditions change.
4. Verify that every required PR is actually merged, then complete task acceptance and save the results.
   Do not additionally wait for post-merge mainline CI unless the user explicitly requires it.

## Ongoing waits

Pending CI, PR reviews and required reviewer approvals are part of continued execution, including reviews performed by a person.
Do not set `properties.paused=true` or request user intervention because these results are pending or a polling wait times out. Keep the task `in_progress` and continue monitoring and delivery; honor any independent user pause, restriction or revocation.
Use bounded listeners or reasonable polling that yields execution; one wait timing out does not end the task.
Prefer the worker's existing continuation mechanism, without creating another scheduling service or claiming continued monitoring after it has stopped.
Inspect new results and handle failures, feedback, and conflicts; ordinary waits do not end the task.

## Request user interaction

Request user intervention only when completing the task requires specific information, a decision, authorization or an action that you cannot supply within the task scope and existing authority. This includes missing necessary goals, architecture, execution plans or acceptance criteria, and problems outside the design that require a user decision or action.
Do not invent missing decisions or treat the problem as completion. Pending PR review, required reviewer approval and CI remain [ongoing execution](#ongoing-waits), even when a reviewer is human or a polling wait times out; they do not justify pausing the task.

Before waiting for human intervention, read the complete task and verify the original active claim, worker and worktree. Use the exact version from that decision to pause your own assigned task:

```bash
daynight task set-property <task-id> paused true --project <project-id> --if-version <observed-version>
```

Read back the task to confirm `properties.paused=true` and the same original assignment. Print the specific issue to the terminal, preserve the [waiting context](task-execution.md#waiting-context), exit the execution loop, and wait for the user to address it.
Keep the task `in_progress` and do not select other work. The user chooses how to intervene, including attaching to the existing session; do not require a particular response channel.

After receiving feedback, reread the task and verify the original assignment, that the problem is solved, and that existing authorization permits resuming. Honor any independent user pause, restriction or revocation. If the problem remains unresolved, keep `paused=true` and keep waiting.
When resuming is permitted, clear a true pause using the newly observed version:

```bash
daynight task set-property <task-id> paused false --project <project-id> --if-version <observed-version>
```

Read back the same assignment and confirm that `paused` is false or absent before continuing the original task. If the user has already cleared the pause, verify that actual state rather than writing it again.

Pause writes and readback follow [write safety](write-safety.md). On a failed or unconfirmed write, report the actual failure, preserve waiting context and reconcile before another mutation; do not claim a confirmed pause or resume blocked work. A changed claim stops task-related writes.

## Complete the original claim

Once shared completion conditions are met and required results are readable, clean up this task's temporary services, probes, and monitoring, including resources left by failed collaborators; preserve controller-owned resources. Clean up before completing, because the worker may stop the agent and remove the workspace after confirming completion.

Read back the complete task, verify the same original active claim, and use the version observed at that point:

```bash
daynight task set-status <task-id> done --project <project-id> --claim-id <claim-id> --if-version <observed-version>
```

The claim ID must be the UUID explicitly supplied in the startup assignment, used only for done, never inferred from the environment or task data.
This is the final task write. Confirm that the response is done, `properties.worker.state=completed`, and the original claim ID is retained.

If rejected or the response is uncertain, follow [write safety](write-safety.md) to reconcile the original claim read-only; do not automatically replay the operation or fall back to ordinary completion.
An unreadable result remains unconfirmed; stop task-related writes immediately if the claim has changed.
Return to the controller after completion; when user intervention is needed, enter the wait defined under [Request user interaction](#request-user-interaction).
The worker manages subsequent work and system resources.
