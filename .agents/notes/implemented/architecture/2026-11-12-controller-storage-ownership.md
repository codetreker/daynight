# Agent Note: Controller storage ownership

Status: implemented

## Problem

Controller writers, historical-format readers, stopped recording and archive
write phases can operate on one execution journal. SQLite serializes a short
transaction but cannot preserve ownership while process evidence is verified or
while several initialization stages run. A stopped record also cannot require an
already-stopped snapshot before it performs the verification that creates one.
Initialization failures can leave a journal, timer or relay alive, and callbacks
can observe dependencies before construction finishes.

## Decision

One branded storage permit owns each execution's journal. The platform's
synchronous instance lock retains the existing PID, startup time, atomic owner
replacement and SQLite ownership gate. Only a confirmed missing process permits
stale ownership takeover. The asynchronous platform entry delegates to the same
implementation, retaining its existing API. Controller helpers pass an existing
permit through local work and validate its owner, path and unreleased state.

Preparation separates format upgrade, maintenance of a proven stopped generation,
and admission of a new writer. The current numbered SQL sequence remains the
single schema owner at v9. A local migration context supplies the original permit
and reserved-write check; current-format reads require neither. This preserves
the message-origin migration and production file-backed candidate body publication.
The independently callable [SQL content components](2026-11-12-session-sqlite-content-components.md)
reuse the permit and role owners for historical import and stopped maintenance;
their staged DDL does not enter numbered production discovery. The
[protocol design](../../../../docs/design/task-session-protocol.md#controller-与原生会话)
owns the role, capacity and failure contracts.

The runtime commits its generation and captured Controller proof together before
native effects, initializes callback dependencies before connecting the relay,
and closes constructed resources through one scope. Its permit is released last,
after journal and media closure is confirmed. Other writers use short local
phases; archive and stopped-tail transport hold no journal ownership while the
network is awaited. Each returning acknowledgement reacquires ownership and
checks the original stopped identity and frozen source. Stopped batch and
acknowledgement settlement retain the existing 8 MiB reserve above ordinary
metadata admission; normal stopped-maintenance is required before the next
writer, while actual numbered migrations keep their reserved-write checks.

Stopped recording holds the permit while verifying the original process boundary
outside a SQL transaction, then compares snapshot, ticket hash and owner PID in a
short write transaction. It creates stopped evidence without demanding it in
advance. The same cleanup deadline bounds local admission and process checks;
close or release failures retain the actual committed transaction outcome. The
[submitted launch decision](../bug-fix/2026-11-12-submitted-controller-launch.md)
continues to own IPC-only acknowledgement, bootstrap identity, Windows Job leases
and the distinction between pre-writer exit and complete native stop.

## Alternatives

**Use SQLite transactions alone.** A write transaction cannot span asynchronous
process verification or an archive transfer without retaining locks and delaying
other owners. Ending it before verification leaves a gap for another writer.
The permit spans the local ownership interval while SQL transactions stay short.

**Require stopped evidence for every maintenance entry.** Upgrade-only reads
must preserve paused or stopping evidence, and stopped recording must first
verify processes to create the stopped state. Applying one admission rule would
prevent those operations from establishing the evidence the rule demands.

**Acquire a lock inside each helper.** Nested helpers would contend with their
own live owner. Explicitly passing one verified permit keeps initialization,
upgrade and stopped recording in a single ownership interval.

## Consequences

A live writer excludes local maintenance, stopped mutation and other writers;
current-format reads retain their existing snapshot behavior. The stored launch
intent survives lock and capacity waiting without another spawn or recovery
budget consumption. Process-state uncertainty, unknown transactions and failed
handle closure remain visible and retain the evidence needed for recovery.

Local ownership adds short gate operations around writable phases and durable
capacity reservation checks before migration writes. It does not change public
Session protocols, image resource ownership, native input deduplication, journal
v9 or candidate body files. The permit governs cooperating local code; it does
not authenticate stored data against a malicious local writer.
