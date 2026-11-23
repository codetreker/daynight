# Agent Note: Coordinate File Storage Through Redis Leases

Status: implemented

## Problem

File storage synchronization used persistent empty files and advisory locks.
This bound coordination to the storage mount's locking semantics and retained
control files for old keys. Servers sharing a deployment need a common lock
identity and abandoned permits need to expire after an owner exits.

## Decision

A configured `DAYNIGHT_REDIS_URL` selects Redis storage gates for the local
backend. The storage and monitoring clients have separate connection pools. Gate keys preserve the
striped target and private domains and exact residency and media domains. One
Redis database identifies one storage deployment. Without Redis configuration,
a standalone server coordinates storage through process-local gates. The
[Azure backend](2026-11-23-azure-archive-backend.md) supports a single Server
instance and uses process-local storage gates even when monitoring uses Redis.

Each Redis permit has a random ownership token and a 30-second TTL. The owner
renews while the permit is open, including after the acquisition context
ends. Renewal and release check the token atomically. A lost lease cancels
work that holds it. Publication and deletion verify every relevant permit
against Redis before changing file contents. The [attachment design](../../../../docs/design/daynight-task-attachments.md)
owns the operation and deployment contracts.

The [archive owner permit](2026-11-21-session-archive-owner-permits.md) uses
the same residency key with a versioned multi-permit value while preserving
exclusion with the original scalar lease protocol.

This supersedes the file synchronization mechanisms in the
[attachment target gate](2026-11-06-attachment-target-gate.md) and
[archive residency](2026-11-07-session-archive-residency.md) decisions.

## Alternatives

**Keep advisory lock files.** They track the open descriptor and automatically
release on process exit. They also require the underlying filesystem to
coordinate locks across all instances and retain files for potentially reused
keys.

**Acquire a fixed-length lease without renewal.** Existing permits span file
I/O, database work and some response transfers. A fixed TTL would release an
active operation when its duration exceeds the TTL.

## Consequences

Locks expire after a crashed owner stops renewing, and old releases cannot
remove a successor's key. Redis coordinates admission independently of the
filesystem. Multiple servers still need access to the same file contents.
Redis failures can interrupt storage operations and a lease cannot fence a
filesystem syscall already in progress. Per-task and per-instance resource
limits and the existing file/database failure boundary still apply.
