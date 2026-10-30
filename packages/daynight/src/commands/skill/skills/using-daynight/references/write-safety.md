# Write safety

Applies to creation, metadata updates, status changes, deletion, and attachment operations.
See the corresponding `--help` for command syntax.

## Decisions and versions

Before modifying or deleting a task, read the complete task, preserve the exact `version` used for the decision, and submit it through `--if-version`.
The version is a complete int64 decimal integer; do not round it.
The CLI's default pre-submission read only fetches the latest version and cannot protect an earlier decision.

On a version conflict, reread and reassess current content, dependencies, and authorization; do not merely substitute the new version and replay the operation.
Requests for the same status or value still check the version. `in_progress` is not an executor lock or renewable lease and does not prove that this session owns the work.

## Uncertain results

A timeout, cancellation, or lost response may occur after a change takes effect; cancellation does not prove rollback.
Before further writes, read actual fields or attachment content to reconcile; do not automatically retry writes.

When a creation result is uncertain, confirm it using complete fields, resource identity, and operation context; a matching title or one empty query is insufficient.
Preserve confirmed IDs and resume missing operations on the original resources, avoiding duplicate tasks or task chains.

If verification is impossible, report the actual error and unconfirmed items without claiming success.
Even if the expected value is readable, an unconfirmed response does not establish that this operation caused the change.
See [task management](task-management.md#task-deletion) and [managed task execution](autopilot-managed-task.md#complete-the-original-claim) for reconciliation specific to deletion and worker completion.

## Attachments and multi-step operations

Attachment writes do not change the task version, status, or update time; a task version cannot protect attachments or freeze cross-task references.
Reread required mutable content before handoff and execution; do not merely compare inventories or timestamps.

Creation, uploads, description updates, and status changes are independent writes, with no cross-operation rollback.
Multiple files may also succeed only partially; verify file bytes and metadata separately.
Reassess affected decisions when sources change.
