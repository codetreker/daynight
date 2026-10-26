# Agent Note: Transactional Task Storage

Status: implemented

## Problem

Concurrent startup and task mutations need persistent data whose schema and
relationships are read consistently. A transaction that checks data before
waiting for another writer can accept a stale graph; a failed dependency write
can otherwise leave task fields and edges disagreeing. Cancelled requests also
need cleanup that survives their cancellation.

## Decision

The concrete store extends the [runtime foundation](2026-10-19-server-runtime-foundation.md)
with embedded migrations, shared core models, project-scoped write callbacks
and read-only snapshots. The [design](../../../../docs/design/daynight-server.md)
owns their detailed behavior. Project/task validation and HTTP operations remain
separate tasks; storage reports facts rather than deciding domain policy.

Startup retains one physical connection and its session advisory lock while it
checks the migration ledger and applies every pending migration. Each SQL file
and its checksum record commit together. The ledger must be an exact ordered
prefix; unknown versions, gaps and changed raw SQL hashes fail visibly. Earlier
successful migrations survive a later failure. Unlock uses the same connection;
an unconfirmed unlock closes that physical session before pool release.

Task writes take the project row lock in their own `READ COMMITTED` statement.
Only later queries read tasks and dependencies. One callback commits task fields,
the complete edge replacement, version and update time atomically. Timestamps
use database statement time, which does not predate a writer that completed while
this transaction waited. Service code compares versions, checks the candidate
graph and states, and decides whether a real update is needed.

Read callbacks use read-only `REPEATABLE READ`. Project existence, task pages,
dependencies and derived readiness come from one snapshot. Filters apply before
keyset pagination; lookahead describes the filtered set. Candidate reachability
removes the replaced task's previous outgoing edges and traverses the proposed
graph without preserving a mutable graph cache.

Transaction rollback and advisory unlock use independent bounded cleanup
contexts. Error wrapping retains driver causes, the resource-not-found marker
and cleanup failures while keeping SQL and credentials out of public diagnostics.
All production writes go through the service's project boundary, with local
database checks and no foreign keys. The original no-deletion assumption is
replaced for tasks by [retained deletion](../../implemented/feature/2026-10-25-task-soft-deletion.md),
which keeps the project write boundary and protects active references. Projects
still have no deletion API.

The common gate expires only project-local Go test results before go-cov.
Go caches coverage profiles without observing external database state, so a
previous pass must not mask a stopped database. See the pinned
[test cache rules](https://github.com/golang/go/blob/go1.27.2/src/cmd/go/internal/test/test.go#L120-L140)
and [coverage replay](https://github.com/golang/go/blob/go1.27.2/src/cmd/go/internal/test/test.go#L1944-L1954).
Build and module caches remain reusable; strict total coverage and all existing
package/function/critical-block gates are unchanged.

## Alternatives

**Read before locking and validate later from that result.** A writer waiting
for another transaction would retain stale prerequisites. Separate lock and
subsequent query statements provide fresh `READ COMMITTED` observations.

**Use transaction-scoped migration locks.** Per-migration commits would release
the lock before the migration sequence finishes. A pinned session lock spans
those commits and provides one explicit connection owner.

**Use `pgx.BeginTxFunc` for all transactions.** Its rollback uses the caller
context and does not retain all cleanup failures. Explicit cleanup preserves
the cancellation and original-cause requirements; see the pinned
[driver implementation](https://github.com/jackc/pgx/blob/v5.11.0/tx.go#L438-L450).

**Rely on cached database test results.** External PostgreSQL availability and
state are absent from Go's cache key. Expiring test results gives each gate a
fresh database observation without deleting compilation or module caches.

## Consequences

The shared `core.Project` and `core.Task` declarations arrive with storage as
prerequisites for later use cases, avoiding duplicate row models. Concrete
callbacks expose only their intended project or snapshot scope. Callers return
operation errors and expose captured resources only after commit succeeds.

Real PostgreSQL tests use owned schemas and instance-specific lock observation.
They cover multi-migration exclusion, ordered history, rollback after actual
partial writes, interleaved snapshots, fresh reads after lock waits, independent
projects, cancellation and cleanup. Unrelated test sessions cannot satisfy the
migration barrier or appear as leaked locks in its assertions.
