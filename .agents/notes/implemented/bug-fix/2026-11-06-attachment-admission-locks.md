# Agent Note: Bound Attachment Authorization to Admission

Status: implemented

## Problem

An attachment mutation can spend a long time in file I/O. Holding authorization
source locks throughout that transfer prevents an independent Project grant or
Team membership revocation from committing, even though admitted transfers are
allowed to finish. For ordinary attachment mutations, Task deletion waits so that
retained attachment bytes cannot change after deletion commits.

## Decision

The ordinary attachment mutation scope implements `ProjectAuthorization` with
`pg.ReadProjectAccess`. After acquiring the Task SHARE lock, it reads ownership,
the current owner Team membership and the direct grant in one statement without
locking their rows. Authorization precedes the Task absence or deletion response.
The Task lock remains held through the deletion check, path validation, file I/O,
transaction-bound metadata write and transaction completion.

This partially supersedes the implementation choice in
[attachment mutation serialization](../architecture/2026-11-06-attachment-task-deletion-serialization.md).
That decision introduced the Task lock to preserve retained files and avoided a
Project lock after Task to preserve write ordering. Both reasons still apply;
the reused authorization helper also held source locks that the attachment
admission contract does not require.

Grant or Team membership revocation can commit while admitted file I/O continues.
The admitted mutation can finish without another authorization check after the
physical change; later admission without a remaining access source is refused.
HTTP credentials are validated at entry. Thread keeps its separate
`LockProjectAuthorization` and credential revalidation rules.

The [attachment design](../../../../docs/design/daynight-task-attachments.md) and
[authorization design](../../../../docs/design/daynight-auth.md) own the complete
current contracts.

## Alternatives

**Keep authorization source locks until the file operation commits.** This
stabilizes authorization through completion but makes revocation wait for an
unrelated slow transfer. It provides stronger ordering than the admitted-transfer
contract requires; Task deletion ordering is supplied by the retained Task lock.

## Consequences

Revocation does not cancel an admitted attachment mutation or retract emitted
bytes. New requests use current authorization, while Task deletion continues to
serialize against ordinary mutations. The [resumable MCP upload](../architecture/2026-11-06-resumable-mcp-upload.md)
uses a separate admitted-commit boundary. The file operation and PostgreSQL commit remain
non-atomic: actual storage and database errors propagate, and a failed or unknown
commit does not trigger guessed file compensation. No cross-storage recovery or
atomicity guarantee is added.
