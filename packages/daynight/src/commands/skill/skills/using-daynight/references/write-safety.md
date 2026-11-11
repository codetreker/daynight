# Write safety

Read this for every create, change or delete operation, alongside its resource
rules for confirmation, identity and recovery. Installed command help gives exact syntax.

## Authorization and scope

Task `assignedTo`, status, readiness, `allowAgents` and claim IDs describe
separate facts and grant no missing authority to register, execute, publish, change access, communicate externally or
deliver. Success or a status change does not establish process control, stop a
running Agent or prove delivery. Host and native Session capabilities differ
from Task metadata; check the actual capability and current authorization.

Inaccessibility is not proof that a service, Project or resource does not exist.
`--project` selects without granting access. Registration and documentation or
observation reads do not start execution. `in_progress` grants no executor lock,
renewable lease or ownership.

## Decisions and versions

`--if-version` binds a write to the version read for its decision: the resource
must still have that version, even for same-value writes. Version tokens and
delivery generations are positive decimal int64 values: preserve every digit
without floating-point rounding.

Before Task metadata, status, property or deletion decisions, read
`task show <task-id> --json` and retain `version`. Other topics identify their
version source. Submit it with `--if-version`; reread before the next change.

Where omission supports a pre-submission read, it fetches the latest version
before writing; failure prevents the write. It cannot protect an earlier decision;
commands requiring an explicit version have no default. On conflict, reread and
reassess content, dependencies and authorization. Never substitute a newer
version to replay the old decision.

Task status/deletion commands always read target type and identity, even with
`--if-version` or `--force`. This read retains the caller's exact supplied version;
omission uses the observed version. Failed identity/type reads prevent writing.
The read can precede a Goal confirmation prompt; it does not refresh an earlier
decision's version. See [Goal impact confirmation](tasks.md#status-and-timing).

## Uncertain results

Timeout, cancellation, lost or malformed responses may follow a committed write;
cancellation does not prove rollback. Retain original IDs, request/operation
identity and known receipts. Never automatically retry a mutation. Follow the
resource's recovery rules before deciding on another write; explicit Webhook
resume has its own admission rules.

Read fields, Thread pages or file bytes for current facts. Matching values do
not identify which operation caused them. Uncertain creation needs complete fields, resource
identity and operation context, not a matching title or one empty query. Keep
confirmed IDs and finish missing operations on those resources.

Confirmed receipts survive later rendering, output or cleanup failure, even
with nonzero exit or partial stdout. Report verification errors and unresolved
items; failed reads are neither empty results nor proof of absence.

## Independent resources and operations

Creation, uploads, description and status are independent writes without shared rollback;
multiple files can succeed partially. Verify bytes and metadata separately.
Attachment writes leave Task version, status and update time unchanged. Task
versions cannot freeze attachment bytes or cross-task references: reread content
when decisions depend on it, and reassess when sources change.
