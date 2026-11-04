# Agent Note: Herdr recording and receipt-bound resource finalization

Status: implemented

## Problem

A terminal viewer cannot provide a reliable task history when nobody is watching.
Native stopping, durable recording, remote archive acceptance and local deletion
also fail independently. Treating them as one successful cleanup either retains
execution capacity indefinitely or deletes the only surviving evidence.

## Decision

The Worker records bounded complete visible frames in its execution data directory,
independently of live delivery. A hash-linked, synchronously committed selection
and index journal surrounds atomic frame-file publication. Deduplicated observation
intervals have durable checkpoints; recovery preserves gaps instead of extending
an old screen through downtime. Recovering a segment without a durable orderly end
retains interruption evidence even when terminal cleanup will never start another
sampler. A crash before any durable frame remains failed; an already persisted
segment end is recovered without inventing an interruption. Exhausted capture also
reuses that end when lifecycle stop intent lags behind source closure; it cannot
start a new elapsed-time accumulator for a closed segment. Recovery tracks
committed frame and gap coverage separately from the last observed frame. A
durable gap_end advances the recoverable segment range even before the next
frame selection; it cannot extend a frame interval or invent a wall-clock time. Native identity
enrichment changes identity only,
including already closed capture segments, without changing their observations.
Post-input observation and ordinary polling reconcile the enriched ledger before
republishing the current complete frame. The snapshot fence and acknowledged
ledger hash remain mandatory. The execution driver receives the successful input
receipt before ledger reconciliation can fail, so a failed publication remains
visible without returning an already transmitted assignment to its pending queue.

The original Session registers recording responsibility before native launch.
After stopping it publishes closed evidence, then freezes one finalization
identity before constructing a fixed seal. Immutable
ready or valid unavailable receipts authorize ordinary worktree cleanup. Missing,
misowned or corrupt registered content remains failed. Legacy absence cannot be
converted to a zero-frame receipt. Transient retries retain the original owner and
body, with durable bounded backoff. An original-owner PAT archive-state read
keeps stopped-ledger and finalization reconciliation available after task deletion,
while ordinary browser state remains inaccessible. Journal readback repeats the
file and directory durability barriers before an intent or receipt can authorize
resource deletion.

Execution capacity depends on local original-process stop proof. An independent
archive queue and count/byte/free-disk gates retain resource accountability after
that slot is released. Explicit identity-checked operator disposition has its own
journal and cannot manufacture archive success. Original-user authentication is
separate from terminal-claim evidence: a permission-hidden 404 cannot authorize
disposal; an observed terminal claim or confirmed task_deleted response can.
Ready local sources are retained;
there is no automatic expiration or garbage collection.
Durable deletion records remain available to reconcile the original local task
and cleanup schedule before releasing their scheduling entries. This closes the
crash window between filesystem cleanup and SQLite updates without completing a
different claim or treating missing execution evidence as proof of deletion.
Retained resources and pending-stop selectors share the same verified deletion
decision, so an unacknowledged stopped ledger cannot restore execution capacity
usage or block a successor claim after completed explicit deletion. The ledger
hash remains unchanged; local resource deletion is not a remote acknowledgement.

The [recording design](../../../../docs/design/herdr-recording.md) owns mechanisms
and limits. This extends [durable lifecycle ownership](2026-11-04-herdr-worker-lifecycle.md)
and [input arbitration](2026-11-04-herdr-input-arbitration.md); their original
staged delivery kept combined capabilities disabled until a recorder existed.

## Alternatives

**Viewer-owned sampling.** It would reduce work while nobody watches, but omits
the unattended history required for task replay and binds disk correctness to a
slow remote consumer.

**Summing raw frame sizes.** This omits JSON string escaping and index overhead,
so apparently bounded sources can exceed the server's immutable archive limit.
The producer accounts for exact serialized files and indexes instead.

**Deleting or skipping damaged frames.** That would turn missing registered
content into apparently successful partial history. Explicit gaps represent known
capture interruptions; they do not repair corrupted source ownership or bytes.

**Holding a slot until upload completes.** A permanently failed archive can block
unrelated tasks forever. Separating execution slots from retained-resource budgets
preserves both scheduling progress and an explicit upper bound on storage debt.

**Replacing gap and frame records with one atomic transition.** A new combined
event could remove one future crash window, but would not repair an existing
journal prefix ending in gap_end. Deriving recovery coverage from every committed
event preserves that prefix without changing the stored format or weakening
archive interval validation.

## Consequences

Recording survives viewer departure and network loss, while receipt-based deletion
survives upload-response loss and cleanup interruption. Each guarantee adds durable
state, filesystem synchronization and integrity work. Sampling still misses brief
output between reads and content outside the visible screen; this is not a PTY log.

Fixed archive limits impose visible partial recording, not unlimited history.
Whole-machine loss before final upload can still lose local history. Runtime remote
backup, chunked archives, automatic source GC and broader terminal management remain
outside this mechanism. Full product claims still require the appropriate native,
server and webpage combination evidence.
