# Agent Note: Persistent Outbox Byte Accounting

Status: implemented

## Problem

Controller outbox capacity must reflect the exact encoded UTF-8 bytes retained
across transactions, restarts and stopped settlement through another connection.
Recounting the whole retained queue on every capacity check makes normal output
processing depend on backlog size, while a process-local count cannot survive
rollback, uncertain commits or another writer.

## Decision

Journal v11 stores one bounded `outbox_totals` row. The shared outbox owner
updates it in the caller's existing permitted write transaction with each insert,
acknowledged prefix deletion or clear. Partial acknowledgements measure only the
rows they delete; complete drains and clears reset the count without enumerating
payloads. Current-format admission checks the singleton and bounded queue edges,
not a full recount. The original owner continues to enforce sequencing, capacity,
acknowledgement and stopped-generation proof.

The 011 migration initializes the total once from the existing encoded text with
Node's UTF-8 byte length, within the original migration transaction. This preserves
the correct unit even when the SQLite file uses UTF-16. The [Controller protocol](../../../../docs/design/task-session-protocol.md)
owns the current transaction and recovery rules. The earlier [version observation
decision](2026-11-13-journal-version-observation.md) supplies canonical version
and migration-stage reporting.

## Alternatives

**Recount or cache the queue.** Recounting at ordinary capacity checks or startup
scans retained payloads; a process cache also cannot represent another connection,
transaction rollback or an unknown commit outcome reliably.

**Maintain the total with row triggers.** Triggers would cover arbitrary SQL writers,
but impose per-row work on full queue deletion and lose the bulk clear path. The
shared owner instead concentrates supported mutations and their accounting.

**Use SQLite BLOB length.** The byte length depends on database encoding; an
existing UTF-16 file does not produce the encoded UTF-8 length required by the
capacity contract.

## Consequences

Capacity reads and full drains avoid a payload scan, while partial acknowledgements
still read the deleted prefix. Every supported writer must use the shared owner and
its original transaction. Detectable singleton, empty-relationship and underflow
errors fail rather than repairing data; an arbitrary positive but incorrect count
cannot be detected without a full recount. On an accounting failure the Controller
fences further queue writes and rechecks that fence immediately before native
side effects, including after asynchronous preparation. Already dispatched native
input retains its original outcome and is not replayed. A failed or uncertain transaction keeps
the existing outcome and error rules, and the migration does not rewrite queue
content or file encoding.
