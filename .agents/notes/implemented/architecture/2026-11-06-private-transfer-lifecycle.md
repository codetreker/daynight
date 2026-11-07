# Agent Note: Reclaimable Private Transfer Content

Status: implemented

## Problem

Temporary attachment bytes can outlive a response, a database connection, or a
server process. Without a durable owner and accounting, an unacknowledged file
publication can consume space indefinitely. A database lease alone cannot prove
that a live filesystem writer has stopped, and a refreshed OAuth access token
must not create a different transfer owner.

## Decision

A persistent transfer record owns each UUID namespace before publication and
binds it to the user, stable PAT or OAuth Grant, direction, target and immutable
parameters. Current credentials and task access are rechecked on external calls.
A shared database ledger reserves bytes and user slots across instances, while
tracking unmaterialized reservations separately from total retained bytes.
Publication receipts and materialization accounting commit together; an uncertain
receipt retains its reservation. The filesystem gate remains held until file
operations finish independently of database locks.

Cleanup first records an admission barrier, cancels local work and acquires the
same private gate. It releases the reservation and slot only after namespace
removal. Failures remain retryable and bounded scans rotate through the backlog.
A late verified result for the original commit can be recorded while its permit
still holds the gate. The [attachment design](../../../../docs/design/daynight-task-attachments.md#mcp-私有传输内容)
owns the current lifecycle and operational bounds. The shared gate's original
[decision](2026-11-06-attachment-target-gate.md) remains in force.

`core/mcptransfer` owns transfer state, operation identity and admission rules.
The service coordinates current authority, ledger transactions and file permits;
the DAO executes locked data operations without owning the state graph.

## Alternatives

**Database leases as cleanup authority.** A lost connection can release a lease
while its writer is still running; deleting on that evidence alone races a late
publication.

**Count only confirmed object receipts.** A crash after publication and before
receipt persistence leaves an object without a reclaimable owner or capacity
charge. A namespace and reservation created first retain responsibility.

**Keep the transfer state graph in the integration service.** This leaves the
domain rules mixed with credential and file coordination, making independent
state transitions difficult to maintain consistently.

## Consequences

Failed deletion and unconfirmed receipts conservatively retain capacity until
reconciliation. Lock stripes can serialize unrelated namespaces. Shared budget
and reserved disk space require deployment sizing for simultaneous private and
target copies; actual disk writes may still fail. The lifecycle supplies common
primitives for direction-specific upload and download operations rather than
registering those tools itself.
