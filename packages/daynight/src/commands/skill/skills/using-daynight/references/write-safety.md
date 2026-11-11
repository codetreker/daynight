# Write safety

Read this alongside the topic for every operation that creates, changes or
deletes a resource. That topic owns its confirmation, identity and recovery
exceptions. Command help supplies the installed version's exact syntax.

## Authorization and scope

Task `assignedTo`, `status`, readiness, `allowAgents` and a claim ID describe
different facts. None creates missing authority to register, execute, publish,
modify access, communicate externally or deliver. A successful request or status
change does not establish process control, stop a running Agent or prove delivery.
Host and native Session capabilities differ from Task metadata; inspect the
actual capability and current authorization before acting.

An inaccessible service, Project or resource is not proof that it does not exist.
Explicit `--project` selects a Project without granting access. Registration,
observations and documentation reads do not start execution. `in_progress` is not
an executor lock or renewable lease and does not establish ownership.

## Decisions and versions

`--if-version` makes a write conditional on the resource's current version
matching the supplied version. Use the version from the observation on which the
decision was based. A mismatch rejects the write even when the requested value
already equals the current value. Version tokens and delivery generations are
positive decimal int64 values; preserve every digit without floating-point rounding.

Before a Task metadata, status, property or deletion decision, read
`task show <task-id> --json` and retain its `version`. Other topics identify the
resource and read that supply their version. Pass the observed version through
`--if-version` and reread before the next change.

When the option is omitted, commands that support a pre-submission read obtain
the latest version immediately before writing. That read cannot protect an
earlier decision. A failed pre-submission read prevents the write. Commands that
require an explicit version have no such default. On conflict, reread and
reassess current content, dependencies and authorization before deciding again;
do not substitute a newer version and replay the old decision.

## Uncertain results

A timeout, cancellation, lost response or malformed response may follow a
committed write. Cancellation does not prove rollback. Preserve original IDs,
request or operation identity and known receipts. Do not automatically retry a
mutation. Follow the resource's recovery procedure before deciding on another
write; explicit Webhook resume has its own admission rules.

Read the relevant fields, Thread pages or file bytes to establish current facts.
Matching current values do not prove which historical operation caused them.
For uncertain creation, use complete fields, resource identity and operation
context: a matching title or one empty query cannot establish the result.
Keep confirmed IDs and finish missing operations on those resources.

A confirmed receipt remains confirmed if later local rendering, output or
cleanup fails; the command may still exit nonzero and leave partial stdout.
If verification fails, report the actual error and unresolved items. A failed
read is never an empty result or proof of absence.

## Independent resources and operations

Creation, uploads, description changes and status changes are independent
writes, with no cross-operation rollback. Multiple files can succeed partially;
verify their bytes and metadata separately. Attachment writes do not change Task
version, status or update time. A Task version cannot freeze mutable attachment
bytes or cross-task references: reread actual content when it affects a decision,
and reassess affected decisions when sources change.
