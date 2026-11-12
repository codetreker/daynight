# Agent Note: Worker configuration facts and report batches

Status: implemented

## Problem

A mutable application item per configuration key couples its original operation,
actual value and latest target revision. Updating a target can relabel older
success without retaining its genuine source. Unfinished stops and unacknowledged
failures also need to survive several targets; requiring that whole local set to
fit one observation can prevent a valid target or stop responsibility from being
installed. Existing schema 4 history can already lack the actual value's original
successful revision, which a migration cannot reconstruct.

## Decision

One schema 5 JSON checkpoint separates the current target and observation
baseline, current verification records, and retained original responsibility.
Each record owns a stable ID, immutable origin, native mode, backoff and its own
failure token. Reused actual values retain their observed source tuple. Migrated
schema 4 success with a lost revision is explicitly unknown. New current records
do not take ownership of an older record's failure or rewrite its history.

The [chunked checkpoint decision](2026-11-12-worker-configuration-chunked-checkpoint.md)
keeps one path, strict incremental reads and atomic persistence. Schemas 1–4
upgrade through the original structural rules; normal execution uses schema 5.
The serialized manager freezes a result before persistence and publishes it only
after the write succeeds. Runtime native proof belongs to the current process
and record identity. Proof propagation examines only native records and indexes
prior current records once, so a large removal collection does not multiply
unrelated key scans. Original stop jobs keep their own identity; a new stop
verification waits for their actual end and checks resources through the original
adapter before new Project preparation becomes ready.

Reports project complete current items into one bounded batch. Latest failure
data for the same key may come from a retained record, but the capture keeps its
exact `sourceRecordId`/`failureId` pair. A real unfinished or failed stop verification has a
fixed slot, with priority derived from its actual retained stop responsibility.
Other eligible items form a continuous lexical prefix of record IDs after a durable
cursor. A first item that cannot fit starts the next batch. Selection measures
Go JSON escaping plus 512 bytes for stored metadata, the 4 MiB observation
budget, 1025 non-mode or 1026 total negotiated items, and the 9 MiB request using
the same report sample that is sent. Matching acceptance retires only sent failure
sources; only a capture from the current generation advances its cursor.

The server replaces the latest accepted batch without merging earlier items.
Omitted target items mean unobserved/pending, while the complete local records
remain available. The [configuration contract](../../../../docs/spec/daynight-worker-configuration.md)
and [Worker design](../../../../docs/design/daynight-worker.md#云端接收与本机提交)
own the detailed behavior. Non-null target revisions retain existing monotonic
policy. The first synchronization installs its observation baseline; later
non-null target observations only advance it, and null uses the canonical zero
baseline. Persistence errors retain the manager's existing failure path.

This decision replaces the shared local/report collection in the
[capacity decision](2026-11-07-worker-current-capacity.md) and extends the
[tool-path cache seam](2026-11-11-worker-tool-path-configuration.md). The earlier
collection was sufficient while current observations fitted one report; its
resource and failure-retention requirements remain, with separate local lifetime
and wire selection.

## Alternatives

**Keep one mutable item per key.** Relabeling its target cannot preserve the
original stop identity, unacknowledged failure ownership and genuine actual-value
source independently.

**Require all facts in every observation.** Valid multi-generation history can
exceed the count or stored-byte limits. Refusing new local responsibility or
discarding old facts to make it fit blocks recovery or loses truthful evidence.

**Clear and rebuild the cache.** This removes unfinished stop work, unknown
outcomes and failures that still require confirmation.

## Consequences

The schema migration and explicit source fields add local representation and
validation cost. Lost schema 4 success provenance stays unknown. Retained facts
require proportional memory and disk, and upgraded checkpoints require a CLI
that understands schema 5. Confirmation and record retirement must consider both
original resource ownership and the exact sent token.

A large state is visible remotely as its latest batch; the server does not
present a fabricated complete history. Newly loaded configuration consumers show
missing target items as pending. The existing mounted Web resource owner still
combines revision counters monotonically, so lower server-state reads can retain
an older view; this representation does not change its editing or read policy.
The fixed stop slot preserves visible unresolved cleanup responsibility, and
persisted continuous-prefix rotation prevents later small items from starving a
large legal item.
