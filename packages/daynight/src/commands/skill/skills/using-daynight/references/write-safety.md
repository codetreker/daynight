# Write safety

Applies to creation, metadata updates, property setting and removal, status changes, deletion, Thread posts, and attachment operations.
See the corresponding `--help` for command syntax.

## Decisions and versions

Before changing task metadata or deleting a task, read the complete task, preserve the exact `version` used for the decision, and submit it through `--if-version`.
The version is a complete int64 decimal integer; do not round it.
The CLI's default pre-submission read only fetches the latest version and cannot protect an earlier decision.

On a version conflict, reread and reassess current content, dependencies, and authorization; do not merely substitute the new version and replay the operation.
Requests for the same status or value still check the version. `in_progress` is not an executor lock or renewable lease and does not prove that this session owns the work.

## Uncertain results

A timeout, cancellation, or lost response may occur after a change takes effect; cancellation does not prove rollback.
Read the corresponding task fields, Thread pages or attachment content before deciding on another write; do not automatically retry writes.

When a creation result is uncertain, confirm it using complete fields, resource identity, and operation context; a matching title or one empty query is insufficient.
Preserve confirmed IDs and resume missing operations on the original resources, avoiding duplicate tasks or task chains.

If verification is impossible, report the actual error and unconfirmed items without claiming success.
Even if the expected value is readable, an unconfirmed response does not establish that this operation caused the change.
See [task management](task-management.md#task-deletion) and [managed task execution](autopilot-managed-task.md#complete-the-original-claim) for reconciliation specific to deletion and worker completion.

## Thread posts

A post appends one immutable message without a task version or client message
Id. The service generates the Id. `--claim-id` authenticates optional execution
attribution; it is not a submission identity and is never inferred.

A fully validated 201 response confirms the message and yields a receipt with
its Id. A later local output or cleanup failure retains that confirmation and
Id. A validated rejection, including `503 clock_not_advanced`, is a definite
failure. A lost response, dispatched transport failure, malformed success,
`503 message_outcome_unknown` or generic server failure leaves the outcome
unknown. The CLI never automatically repeats POST.

Keep the original body available and read normal Thread pages before deciding
to send again. Equal text cannot establish that the earlier request succeeded;
a new explicit post creates another message. Reading does not manufacture a
submission receipt, and a post receipt cannot advance the continuously read
position past other participants' unread messages.

## Attachments and multi-step operations

Attachment writes do not change the task version, status, or update time; a task version cannot protect attachments or freeze cross-task references.
Reread required mutable content before handoff and execution; do not merely compare inventories or timestamps.

Creation, uploads, description updates, and status changes are independent writes, with no cross-operation rollback.
Multiple files may also succeed only partially; verify file bytes and metadata separately.
Reassess affected decisions when sources change.
