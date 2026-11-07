# Agent Note: Session Archive Residency

Status: implemented

## Problem

A complete Session archive can occupy tens of MiB during upload, validation,
storage readback and response delivery. Concurrent operations multiply that
memory use, and a stalled peer can retain it indefinitely. HTTP-only admission
would leave direct core calls and internal reads outside the limit.

## Decision

Archive operations acquire nonblocking per-instance and per-original-owner
capacity before consuming large bodies or objects. Owner slots use the exact-key
residency gate shared by instances using the same storage root. A short access
scope obtains trusted ownership before acquiring capacity, with a separate
nonblocking preflight slot preventing unbounded database waiters; the business operation
retains its own authorization, fence and lock ordering. Nested readback shares
its operation, and returned content owns the lease until closed. Independent
socket deadlines bound upload reading and response sending. The [Session
protocol design](../../../../docs/design/task-session-protocol.md#归档操作占用)
owns the lifecycle and failure contract.

## Alternatives

**Limit only HTTP handlers.** Direct core and nested storage operations could
still allocate archives concurrently, and releasing on service return would not
cover a blocked response.

**Hold a database connection for the owner slot.** A single-connection pool
could not execute the business transaction while the lease held that connection.

**Reuse striped blocking storage locks.** Unrelated owners can collide and the
wait queue would not provide immediate capacity refusal. Exact keys and a
nonblocking attempt avoid both effects.

## Consequences

The budget bounds simultaneous archive operations, not total stored data. Stable
lock files remain in the shared storage root to prevent inode splitting across
instances. Slow peers are interrupted by operation-specific deadlines without
imposing a global write timeout on long-lived connections. Original ownership,
finalization and immutable archive byte semantics remain in force.
