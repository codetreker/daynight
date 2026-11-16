# Agent Note: Remove Controller cumulative metadata admission

Status: implemented

## Problem

A Controller journal can exceed a cumulative metadata threshold even when its
individual records and protocol content are valid and actual storage writes can
succeed. Estimated headroom cannot reserve filesystem space, and coupling it to
publication, maintenance and recovery prevents these operations from completing.

## Decision

Controller operations no longer impose cumulative metadata or preparation
limits, settlement headroom, or future-byte reservations. Actual filesystem and
SQLite failures retain their original outcome and cleanup semantics. Single-record,
content and protocol limits, outbox backpressure and runtime concurrency remain.
Physical journal metrics remain for observation and compaction verification.

The native index reservation remains an exclusive writer lease with its original
identity and process proof. Reconciliation requires proof that the original writer
stopped, and release verifies the lease identity. Journal migration 013 removes
only `maximumBytes` from valid JSON objects without creating or deleting leases;
malformed and non-object values remain unchanged. Capture source identities and
file lifetimes remain unchanged.

This decision completes the removal begun by the [media ledger](2026-11-16-controller-media-ledger-removal.md)
and [free-space and peak admission](2026-11-16-controller-free-space-admission-removal.md)
decisions, and supersedes the retained metadata policy in the [capacity-free
upgrade](../architecture/2026-11-16-controller-capacity-free-upgrades.md),
[storage ownership](../architecture/2026-11-12-controller-storage-ownership.md),
[SQL content](../architecture/2026-11-12-session-sqlite-content-components.md),
[SQL activation](../architecture/2026-11-12-session-sqlite-activation.md),
[atomic publication](../architecture/2026-11-10-atomic-content-publication.md),
[media core](../architecture/2026-11-09-unified-session-media-core.md), and
[image sources](../architecture/2026-11-05-session-image-sources.md) decisions.

## Alternatives

**Retain or raise the metadata budget.** Any finite cumulative limit can reject
valid work before an actual write fails, while an estimate cannot guarantee space.

**Remove the native reservation entirely.** Its identity and process proof also
serialize index writers; deleting it would permit concurrent writers or unsafe
recovery. Retaining only a lease preserves that ownership.

## Consequences

Actual storage exhaustion may interrupt operations. Original sources, committed
stages, unknown outcomes and cleanup responsibilities must remain observable.
No no-op budget or compatibility branch substitutes for the removed policy.
