# Agent Note: Adopt one SQL owner for current Session bodies

Status: implemented

## Problem

Cumulative tool output repeatedly replaces a Session entry, but immutable body
candidates retain every replaced version. Their physical cost can exceed the
metadata budget while the final readable history remains small. An earlier WAL
snapshot can still reference an old file, so deleting superseded candidates
without proving reader completion would corrupt a valid history view.

The [atomic publication decision](2026-11-10-atomic-content-publication.md)
established that body visibility, native image association, Markdown state and
outbox must commit together. Its original choice kept bodies separate from the
journal to preserve the established storage and budget boundaries. Repeated
cumulative output exposed the cost of retaining those body revisions.

## Decision

The canonical journal sequence ends at `010-timeline-content.sql`. That single
DDL creates current body rows and totals, records legacy cleanup pending, and
drops the old content index. The existing format owner generates snapshots and
validates the same numbered sequence; there is no staged SQL copy, runtime format
selector or second schema validator. The published message-origin migration and
its original operation/entry relationships remain unchanged.

Every ordinary producer and reader uses `SessionContent`: one validated current
row per entry in the original journal, plus the existing resource-file owner.
The original writer transaction commits body, count/UTF-8 byte totals, Markdown
state, native image facts, provenance and outbox together. Same-content publication
remains a no-op; unknown commits retain quarantine and query the original operation
without another native send. Current-row patches prevent late receipts or Markdown
rebases from overwriting newer text or image positions.

Pages query bounded rows, while inspection coverage synchronously traverses the
whole snapshot without retaining a body map. Complete-entry chunks reconstruct
the established canonical JSON and detect revision/hash/length changes. Sequence
and revision stay positive signed int64 values and remain decimal strings on the
wire. Current timeline JSON retains its exact 64 MiB/100000-entry limit; replaced
revisions do not accumulate in logical totals.

Migration and maintenance use the delivered
[SQL components](2026-11-12-session-sqlite-content-components.md) and original
[storage permit](2026-11-12-controller-storage-ownership.md). Historical imports
preserve their committed source and all original execution/operation/native
facts. Upgrade-only preserves stopping evidence. Proven stopped maintenance
holds the permit through the reader barrier, durable removal of obsolete index
references, recognized body retirement, in-place VACUUM, post-checkpoint physical
verification, pending-clear readback and actual reservation settlement. A new
writer commits no generation until maintenance and normal admission succeed.

Active history sync and stopped archive work materialize timeline, resource
descriptors and source cutoff in a short SQL snapshot. The resource owner validates
available originals sequentially during construction in that snapshot. Frozen
archive objects retain materialized values, cloned descriptors and only the
dedicated file acquisition capability. Each resource obtains one lease lazily,
compares its metadata and full length/SHA-256 with the frozen descriptor through
the same held FD, and retains that FD through status, retries and chunk reads.
A finally boundary closes it before the next resource. Acquisition does not
establish a fresh SQL snapshot; existing pins and lifetimes, plus fresh SQL
`assertFrozen()` checks, continue to protect the original source.

The snapshot ends before network work. The mutable resource owner and SQL-bound
timeline, metadata and guarded deletion operations do not enter the frozen object.
A later local write reacquires the original ownership and checks current identity.
The [current design](../../../../docs/design/session-sqlite-content.md) owns the
detailed interfaces, ordering and failures.

## Alternatives

**Keep immutable candidates and add delayed deletion.** Every independent reader
would need a proven lifetime protocol before old files could be removed. SQLite
WAL already provides the snapshot mechanism needed for current rows.

**Keep an append-only body revision table.** Product reads and archives need
current entries, and cross-request changes already report `content_changed`.
Persisting every cumulative revision retains the same space amplification.

**Activate writers, readers or entry points separately.** Publication, resource
guards, inspection, archive and recovery share one journal. Partial activation
would leave competing body authorities or an unreadable intermediate format.
All consumers therefore adopt the same current-row owner together.

**Pre-open every available resource FD while freezing.** Holding all originals
would make open FD demand scale with the legal resource count and can exhaust
process capacity. Lazy acquisition bounds that demand while verification against
the original cloned descriptor through the retained FD preserves the frozen
byte identity. It reuses existing resource pins, leases and source checks without
adding another lifetime protocol.

**Treat logical conversion as physical reclamation.** Existing free pages, WAL
and retained source files still consume disk. Only reader-safe retirement,
post-VACUUM checkpoint, actual file measurement and reservation settlement can
restore ordinary admission.

## Consequences

Repeated updates keep one current SQL row and use WAL snapshots for older readers.
The journal now contains full standardized conversation bodies, so its existing
private permissions and backups cover content as well as control metadata.
Resources, pins, leases and native recovery files retain their original paths and
retention responsibilities.

Physical metadata pressure remains possible with long readers, unacknowledged
outbox or other retained data. The 128 MiB ordinary limit, 8 MiB settlement reserve,
shared media limits and free-space policy remain in force; normal execution does
not VACUUM. Format import can be committed and readable while cleanup remains
pending and a new writer waits. Cleanup, commit uncertainty and failed settlement
retain the actual phase and sufficient charge for reentry.

Large revision and capacity probes run separately from routine CI. Generated
fixtures establish only their declared bytes, order, outbox/ACK and reader
conditions; they do not establish original incident replay or equivalent
performance to an isolated model. Complete execution TTL/deletion and native
stopping-evidence gaps retain their own lifecycle responsibilities.
