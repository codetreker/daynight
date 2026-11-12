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
2. Actively monitor remote HEAD, CI, reviews, and conflicts. Before entering or continuing a wait, apply the review-action decision below.
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

## Review-action decision

Read the current PR HEAD, required checks, review decisions and the complete set
of unresolved review threads, including previously known threads. Follow all
pagination; failed or incomplete reads mean unknown, not no feedback. An outdated
thread is not automatically fixed: verify its concern against the current HEAD.
Review summaries, approval state and green CI do not replace thread inspection.

For each unresolved concern, establish its disposition, supporting evidence and
who must act next. Fix, verify and submit changes within existing scope and
authorization before waiting. If the concern is inapplicable or disputed, prepare
an evidence-based response and publish it when authorized; a private rationale or
edited PR description does not itself resolve the review thread. Resolve threads
only when their concern is settled under repository rules. Feedback is evidence
to assess, not authority to expand scope or override the user.

Separate authorization for local corrections, branch delivery, public responses
and additional work. Reuse existing authorization without asking again. An
explicit restriction on public replies does not block authorized local fixes or
validation. Removing an unrelated change from the current PR can preserve the
original goal; delivering that change separately needs its own applicable scope
and authorization. A request for an additional feature does not by itself require
putting it in the same PR. If a confirmed constraint really prevents the required
next action, finish other authorized work and identify the exact conflict or
missing permission, the action needed and the decision maker. Use the execution
mode's intervention rules; do not describe this as waiting for review.

Wait only when no authorized action remains with the agent and the next action
belongs to CI, a reviewer or another external party. Record the concrete wait
condition and next check. No new comments does not mean no unresolved work. Keep
normal CI/review waiting distinct from a user decision or permission blocker.
An unchanged HEAD, check result and thread disposition should not generate a
stream of equivalent chat messages. Report changes, actions or decisions needed;
use infrequent concise summaries during long unchanged waits. Native Working
reports an active turn, not evidence that PR delivery is advancing.

## Scenario validation

Prompt assembly tests establish delivery of the rules; they do not establish
model compliance. Evaluate concrete decisions against the actual assembled
instructions and this workflow, using controlled PR facts and no live mutations:

| Scenario | Required decision |
| --- | --- |
| Known unresolved scope comment, no new comments, green CI | Address the old concern; do not keep waiting merely because nothing is new. |
| Extra CI work is authorized, but same-PR delivery is not required | Separate its scope from the original feature; do not infer that both must remain in one PR or that separate delivery is newly authorized. |
| A comment is disputed with evidence | Prepare and, when allowed, publish the reasoning; wait for review only after taking the available action. |
| Public replies prohibited, fixes authorized | Complete fixes and validation; isolate any remaining reply restriction. |
| Necessary action explicitly lacks authorization and no other authorized action remains | Request the specific missing decision through the intervention workflow, without repeating already granted requests. |
| All actionable feedback addressed, required review or CI pending | Continue normal external waiting without pausing, merging early or duplicate status chatter. |
| Review pagination fails, or an outdated thread has not been checked against HEAD | Preserve uncertainty and finish verification before claiming no actionable feedback. |

Retain counterexamples and limitations in validation evidence. A passing scenario
exercise is not proof that every Provider, existing Session or production review
will follow the policy.
