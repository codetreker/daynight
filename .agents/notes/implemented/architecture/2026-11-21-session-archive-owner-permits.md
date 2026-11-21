# Agent Note: Session Archive Owner Permits

Status: implemented

## Problem

An owner-wide exclusive archive gate prevents unrelated Sessions belonging to
the same owner from using available capacity. Concurrent operations on one
Session can still conflict over archive objects and receipts, and physical
cleanup must not overlap any archive operation belonging to that owner. Servers
using different versions must continue to coordinate during a rolling upgrade.

## Decision

The [archive residency decision](2026-11-07-session-archive-residency.md)
retains instance and original-owner admission and operation lifetime. An owner
permit admits different Sessions up to its supplied limit, excludes duplicate
Session operations, and grants physical cleanup exclusive access to the owner.
The [capacity configuration decision](2026-11-21-session-archive-capacity.md)
sets the production instance and owner limits independently.

Standalone gates check and reserve under one process-local lock. Redis keeps the
existing owner residency key and string type. A versioned value represents
individual tokens, Sessions and deadlines; atomic operations use Redis time to
discard expired entries and retain the key until the latest active deadline.
The old scalar value is exclusive to a new server, while an old server's
`SET NX` refuses a new value. Renewal, verification and release act only on the
matching token. The existing lease-loss cancellation and verification before
storage writes remain in force. The [Session protocol design](../../../../docs/design/task-session-protocol.md#归档操作占用)
owns the operation and cleanup flow.

## Alternatives

**One key per Session.** It would permit concurrent Sessions, but cannot atomically
enforce owner capacity or exclude owner-wide physical cleanup, and old servers
would not see the new keys.

**Change the Redis key type.** A separate collection could represent permits,
but old scalar lease commands would fail or cease to coordinate with it during
upgrade and rollback.

## Consequences

Different Sessions can use available owner capacity without weakening same-Session
exclusion or cleanup protection. Unrenewed permits expire and delayed release
cannot remove a successor. Redis lease loss can still interrupt I/O and cannot
fence a filesystem syscall already in progress, as described by the [storage
gate decision](2026-11-19-redis-storage-gates.md). Servers sharing a coordination
domain must coordinate owner limits: raising the limit during a rollout allows
up to the largest active limit; lowering it requires draining higher-limit nodes
before admitting work at the lower limit.
