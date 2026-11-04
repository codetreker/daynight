# Write safety

Applies to Project, Team and task creation and changes, property setting and removal, status changes, deletion, Thread posts, and attachment operations.
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

## Team writes

With authorization, use `team create`, `team rename` and `team delete` for
ordinary Team lifecycle changes. Rename and delete resolve the explicit or
default Team and read its real name and version. Supply the exact positive int64
through `--if-version` when a decision depends on an earlier observation; a
default pre-submit read cannot protect that earlier decision. Conflict requires
a fresh observation and decision, not a substituted version and replay. A
specified version that differs from the read Team version is rejected locally.

Writes need interactive confirmation or the boolean `--confirm` flag. Delete's
interactive challenge is the displayed JSON string literal, decoded and matched
exactly against the raw Team name. `--confirm` skips the challenge but still
submits the real name and version; it does not waive authorization or service
preconditions. Without confirmation, a non-interactive call does not write.
Personal Teams cannot be renamed or deleted, and deletion requires an empty Team.

A lost, cancelled or malformed response can follow a commit. Do not repeat the
write automatically. Read current facts before another decision, but do not
claim the original operation succeeded merely because current state matches;
Team names can be duplicated and a read cannot restore a lost receipt.

## Project transfers

With authorization, use `project transfer` with a target Team UUID or an exact
same-service Team link. The preview identifies the Project, source and destination
and the actor's expected access. Confirm the decision interactively or use the
boolean `--confirm` flag. The command submits the observed ownership and destination
versions with the current identity; a conflict requires a new preview and decision.
The receipt can confirm success with no remaining actor access. Do not replay an
unknown submission automatically: a later Project read, including 404, cannot
prove whether the transfer committed. Grants and invitations remain independent.

## Task Step writes

Read `task step list <task-id> --json` for the complete current collection and
parent Task `version` used for a decision. Steps share that exact positive int64
version with versioned Task metadata, status and property writes. Supply its
unrounded digits via `--if-version`;
the default pre-submit Steps read cannot protect an earlier decision. A real
change increments the parent version once; a no-op preserves version and times,
but a stale same-value write still conflicts. On conflict, reread the collection
and reassess under project rules instead of replacing the version and replaying.

A lost, cancelled or malformed write response can follow a commit. Keep the
original Project, Task, Step ID and request UUID; read current facts under that
same scope before deciding again. For an unknown add, do not choose a replacement
ID or retry automatically. Same title, present ID or current absence cannot prove
which historical operation occurred. The CLI may make at most one read in the
still-live operation; it reports current facts only, and the write remains
unknown. If no observation is available, use explicit-project list/show with
the original ID. Never automatically replay a mutation or claim rollback from
an unknown result.

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
