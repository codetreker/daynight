# Agent Note: Single-table token usage

Status: implemented

## Problem

Task execution state cannot establish how many model tokens were consumed.
Retries, native recovery and cumulative snapshots can count the same work more
than once, while missing native data can look indistinguishable from a genuine
zero. Reporting can also arrive after an execution finishes, without being
authorized to modify its successor.
The current Session snapshot also advances on reconnect, so it cannot prove
every field of the original usage registration.

## Decision

The [usage contract](../../../../docs/spec/task-token-usage.md) separates
execution coverage from native measurements in one `usage_records` table.
Existing Sessions remain the execution authority. Native source identity spans
Controller generations, and measurements retain their originating execution
state. Source revisions replace facts rather than adding transmission attempts.

The [backend design](../../../../docs/design/task-token-usage.md) uses independent
bounded usage grants and HTTP acknowledgements. Late reporting retains the
original authorization window; it does not acquire a claim or extend authority
to a new execution. SQL aggregates current counted facts, preserving decimal
precision and explicit unknowns. Read-time coverage includes unregistered
executions and expired collectors.

Coverage fixes the existing Session scope once and uses predicate-matched
partial indexes for known measurements and attribution gaps. Sessions without
measurements remain in the result. It reads only state identity and coverage
fields; API records keep their independent complete projection.

The private grant hash record combines a versioned token hash with an immutable
registration-identity digest. Rotation preserves that digest, allowing exact
registration replay checks after the live Session connection advances. This
uses the existing opaque `bytea` field without exposing authentication metadata
or adding an authorization table.

Native profiles choose a single evidenced measurement plane. Copilot exposes
partial output, Claude exposes partial root-message input, and Codex cumulative
snapshots do not enter the counted plane. Current Chain and Goal membership
provides views over the same ledger, not another accounting store.

## Alternatives

**Measurements without execution coverage.** This cannot distinguish a complete
empty execution from an unregistered or failed collector. A state row in the
same table preserves the distinction without introducing a second Session.

**Summing cumulative snapshots or taking their maximum.** Arrival order and
local revisions do not establish native authority, and context estimates are
not consumption. This would produce precise-looking but unprovable totals.
Partial evidenced facts retain useful measurements without inventing coverage.

**Reusing Session cumulative acknowledgements.** A timeline acknowledgement
does not prove a usage batch was persisted and can discard unrelated pending
measurements. Independent acknowledgements keep delivery identities separate.

**Relying on the live Session snapshot for registration replay.** Reconnect
replaces the connection epoch, losing the original comparison value. Separate
identity columns would widen the storage schema for equality-only evidence;
a private hash envelope retains that evidence and independently rotatable
token hashes in the existing credential field.

**Historical aggregate membership.** A financial point-in-time membership ledger
would require another stored history and product contract. Current distinct
members satisfy operational summaries, with deletion exclusions and observation
times made explicit.

**Unfiltered measurement probes and complete state rows for coverage.**
Per-Session existence checks without predicate-matched indexes inflated
PostgreSQL's estimated plan cost enough to trigger costly JIT compilation.
Decoding full ledger rows also transferred and allocated unused fields.
Selective indexes and a narrow state projection preserve the same semantics
without changing database settings or performance thresholds.

**Grouped measurement flags.** Grouping all active measurements added scans on
top of the totals query. These facts only require existence, so indexed probes
avoid materializing or regrouping the full measurement set.

## Consequences

Only one business table is added, and usage does not change Task versions or
sorting. Unknown totals remain null; profile limitations are visible rather
than hidden behind estimated complete totals. Consumers must support partial
metrics, source conflicts and pagination resets.

Late uploads remain bounded by the original grant and parent credential.
Losing the only token after an execution ends can leave an explicit data gap.
This is not a permanent import credential or a billing ledger. Broader native
profiles require new evidence and cannot reinterpret an already counted source
under another profile.

Grant hash records have a strict versioned encoding. Malformed stored values
fail explicitly rather than weakening original-identity verification. Clients
never consume this private encoding; changing it requires compatible stored
record handling.

Coverage indexes add storage and write maintenance. Native revisions that alter
canonical metrics can also affect the known-measurement predicate; this cost
buys bounded existence checks instead of repeatedly scanning ledger history.

Migration retention means rollback requires a binary that recognizes the usage
migration even when its feature is disabled. Removing migration history or the
table is not a compatible rollback.
