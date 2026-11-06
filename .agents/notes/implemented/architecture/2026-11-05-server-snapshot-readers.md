# Agent Note: Server Snapshot Readers

Status: implemented

## Problem

Snapshot consumers need a shared view of authorization and data without gaining
transaction execution or write capabilities. A concrete callback type couples
all readers to the current storage implementation and makes subsequent domain
separation require a simultaneous replacement of the whole data-access surface.
Transaction completion also needs a common representation that preserves unknown
outcomes and the causes of operation and cleanup failures.

## Decision

`SnapshotReader` provides a callback-scoped `SnapshotScope` with domain-specific
readers and a database observation time. The existing PostgreSQL implementation
binds every reader to the same read-only Repeatable Read transaction. Consumers
use the reader required by each helper, and retain the established ordering of
staged business refusals and transaction completion failures.

`Completion` and `TransactionOutcome` describe durable outcome facts, while the
existing error types retain their phase, cause chains and cleanup facts. The
current concrete implementation and SQL remain in the store root. Identity writes
use the [identity boundary](2026-11-05-server-identity-boundaries.md);
Team writes use the [Team boundary](2026-11-05-server-team-boundaries.md),
and Project writes use the [Project boundary](2026-11-05-server-project-boundaries.md).
Other write scopes continue to use their existing contracts.

## Alternatives

**Expose the concrete snapshot to callbacks.** Its shared transaction provides
consistency, but couples every consumer to implementation details and prevents
expressing domain read capabilities independently.

**Use one broad read/write DAO for all scopes.** A read callback would receive
mutation capabilities even though it runs in a read-only transaction, obscuring
the boundary that later domain writers must preserve.

## Consequences

Authorization and data from different readers retain a single snapshot, and a
failed completion remains visible ahead of a staged refusal. The readers are
valid only during their callback. The store root still contains PostgreSQL
implementation details; separating that implementation and introducing the
remaining domain write capabilities require their respective later work.
