# Delivery

## Worker delivery results

| Task type | Required results |
| --- | --- |
| Research | Provide the full research report as a task attachment. |
| Design or architecture | Provide the full solution as a task attachment after multiple independent reviews, with no Critical/Major issues; attach a separate review file for remaining nonblocking issues. |
| Development | All required delivery PRs are actually merged, and task acceptance criteria are met. |
| Acceptance | Complete acceptance against the criteria, collect evidence, and upload it as task attachments. |

These requirements apply to worker-managed tasks and supplement the [shared completion conditions](task-execution.md#completion-conditions).
Task descriptions and source organization follow the [task content standard](task-content.md); inline content cannot replace attachments explicitly required by this table.
Goal confirmation points still require human confirmation; the assignment does not authorize executing other stages.

## PR delivery

For authorized PR delivery, sustain the following workflow:

1. Commit, push, and create or update focused PRs promptly under repository conventions; use the default Git identity and omit AI co-author attribution.
   Merge main into the work branch only to resolve conflicts, then verify in that workspace; leave a conflict-free branch unchanged.
2. Actively monitor remote HEAD, CI, reviews, and conflicts.
   Inspect failure logs first; each failed check on the same commit may be rerun at most twice beyond its initial run, without first proving a transient infrastructure cause.
   Count retries across sessions, restarts and workflow reruns. If both retries fail, diagnose and repair the cause before further validation.
   A passing retry does not establish the root cause or relax required checks and acceptance criteria; report retries and observed results.
   Refresh checks and reviews after every push.
   Fix Critical/Major issues in the current change and defects that would make delivery incorrect; defer smaller or unrelated improvements under project rules, without creating tasks on your own.
   Respond in each thread with the fix, deferral, or reason for not adopting the finding, identify the agent, and resolve threads under repository rules.
   Require an independent review and continue until the final round has no new Critical/Major issues and remote review requirements are met.
3. Immediately before merging, refresh HEAD, required checks, blocking threads, mergeability, and approvals for the current HEAD.
   Once all requirements and explicit authorization are met, merge using a linear method permitted by the repository; bind the operation to the verified HEAD when the platform supports it.
   Do not infer approval from silence, self-approve, bypass protections, or weaken checks.
   Reassess if HEAD or conditions change.
4. Verify that every required PR is actually merged, then complete task acceptance and save the results.
   Do not additionally wait for post-merge mainline CI unless the user explicitly requires it.
