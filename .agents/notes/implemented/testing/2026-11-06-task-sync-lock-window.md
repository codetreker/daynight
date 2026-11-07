# Agent Note: TaskSync Lock Window Tests

Status: implemented

## Problem

Two TaskSync regressions each held a real Project lock through an 11-second
database sleep. They need a blocked writer and a database time interval longer
than the synchronization overlap, but waiting for the production-sized interval
adds more than 22 seconds to every execution. A shorter unconditional delay alone
would not establish the lock state or the database-clock boundary.

## Decision

Both regressions inject a named 20-millisecond overlap through the existing
`NewTaskSync` constructor. They retain real PostgreSQL transactions and the
`waitForTaskWriters` barrier. A database clock sample taken after the waiter is
observed blocked defines the interval; bounded polling must cross that interval
before the holder proceeds. The writer result channel must still be empty while
the lock is held.

The delayed holder's first write must receive a timestamp after the observed
database boundary. The waiting writer must receive a later timestamp, and the
delta must contain both Task IDs and committed versions. The uncommitted-write
regression reads through another real snapshot while the lock is held: both
committed versions remain visible, and `ObservedAt` must be later than the
uncommitted write's timestamp plus the injected overlap. Commit then exposes the
complete delta using the caller's original watermark.

Initial rows in the uncommitted-write fixture receive the same real database
timestamp and are reloaded before the baseline. This isolates the intended
window proof from the incidental duration between two fixture creations.
Subsequent write timestamps and snapshot observations remain database values.

The [test guide](../../../../packages/daynight-server/README.md#tasksync-lock-and-time-windows)
owns the testing guidance. Production timing, the existing explicit 10-second,
30-second and nanosecond cases, and unrelated credential-expiry tests retain
their existing behavior.

## Alternatives

**Retain the production-sized sleeps.** They establish a long interval but repeat
22 seconds of waiting despite the constructor already supporting an injected
window. The separate window cases retain coverage of configured durations.

**Only shorten or remove the sleeps.** A host delay cannot prove PostgreSQL time
crossed the required boundary, and omitting the lock observation could let the
second writer complete before the assertion.

**Use a load-dependent overlap.** Deriving the window from fixture latency makes
the interval and runtime vary with load. Aligning the two initial stored
timestamps keeps a fixed window without replacing the real concurrent writes.

**Replace PostgreSQL with a mock clock or DAO.** A mock cannot establish real
Project lock exclusion, uncommitted visibility or statement-time assignment
after a blocked transaction resumes.

## Consequences

The tests retain database waits, bounded failure paths and real transaction
ordering while avoiding production-sized idle intervals. They depend on a
responsive PostgreSQL test fixture; failure to observe a waiter or cross the
database boundary is an error rather than a skipped proof.

Representative watermark faults compare the original and shortened regressions.
Source-bound validation records own measured runtime and fault results; scoped
local improvements do not establish hosted whole-job savings.
