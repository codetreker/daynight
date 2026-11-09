# Agent Note: TaskSync Lock Window Tests

Status: implemented

## Problem

Two TaskSync regressions originally held a real Project lock through an
11-second database sleep. They need a blocked writer and a database time interval
longer than the synchronization overlap, but waiting for the production-sized
interval added more than 22 seconds to every execution. A shorter unconditional
delay alone would not establish the lock state or the database-clock boundary.

## Decision

The physical lock-window witnesses use a named 20-millisecond test overlap in
store tests. They retain real PostgreSQL transaction scopes. The barrier observes
a waiting transaction blocked by the held Project transaction's exact backend
PID. A database clock sample taken after that observation defines the interval;
bounded polling must cross it before the holder proceeds. The waiting writer's
result channel must remain empty while the lock is held.

The delayed holder's first write receives a timestamp after the observed
database boundary. The waiting writer receives a later timestamp, and the delta
contains both Task IDs and committed versions. The uncommitted-write witness
reads through another real snapshot while the lock is held: both committed
versions remain visible, and `ObservedAt` is later than the uncommitted write's
timestamp plus the test overlap. Commit then exposes the complete delta using
the caller's original watermark.

Initial rows in the uncommitted-write fixture receive the same real database
timestamp and are reloaded before the baseline. This isolates the window proof
from the incidental duration between two fixture creations. Subsequent write
timestamps and snapshot observations remain database values.

The original service regressions injected the overlap through `NewTaskSync` and
used `waitForTaskWriters`. The [Task service ownership decision](2026-11-08-task-service-test-ownership.md)
places the physical clock, lock and discoverability witnesses in store tests.
Service tests control exact DAO windows and retain overlap validation without a
database dependency.

The [test guide](../../../../packages/daynight-server/README.md#tasksync-lock-and-time-windows)
owns the testing guidance. Production timing, the existing explicit 10-second,
30-second and nanosecond window cases, and unrelated credential-expiry tests
retain their behavior.

## Alternatives

**Retain the production-sized sleeps.** They establish a long interval but repeat
22 seconds of waiting even though the original constructor supported an injected
window. Separate window cases retain coverage of configured durations.

**Only shorten or remove the sleeps.** A host delay cannot prove PostgreSQL time
crossed the required boundary. Omitting lock observation could let the second
writer complete before the assertion.

**Use a load-dependent overlap.** Deriving the window from fixture latency makes
the interval and runtime vary with load. Aligning the two initial stored
timestamps keeps a fixed window without replacing the real concurrent writes.

**Replace PostgreSQL with a mock clock or DAO.** A mock cannot establish real
Project lock exclusion, uncommitted visibility or statement-time assignment
after a blocked transaction resumes. It can prove the separate service query
window and admission decisions.

## Consequences

The tests retain database waits, bounded failure paths and real transaction
ordering while avoiding production-sized idle intervals. They depend on a
responsive isolated PostgreSQL environment; failure to observe the specific
waiter or cross the database boundary is an error rather than a skipped proof.

Representative watermark faults compare the original and rewritten regressions.
Source-bound validation records own measured runtime and fault results; scoped
local improvements do not establish hosted whole-job savings.
