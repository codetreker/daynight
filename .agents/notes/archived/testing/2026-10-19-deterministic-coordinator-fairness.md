# Agent Note: Deterministic Coordinator Fairness

Status: implemented

## Problem

Independent CI queries can make waiting PRs eligible at different times. A
fairness test that combines a two-millisecond polling interval with real worker
delays can expire one PR's CI evidence while another remains ready. An exact
launch-order assertion then confuses CI readiness with queue fairness. The
[Ubuntu failure](https://github.com/codetreker/day-night/actions/runs/39211124979/job/117924515363)
observed launches `[1, 3, 2]` where the test expected `[1, 2, 3]`.

## Decision

The coordinator fairness test uses the existing injected clock and deferred CI
responses and worker completions. Coordinator time advances explicitly until
SQLite records the hot PR's newer revision, then remains fixed while admissions
are compared. Passing CI evidence cannot expire because of host load.

Both waiting PRs receive passing CI before the first worker is released. The
scenario covers both CI response orders. Worker barriers expose each reservation
and completion, and the test requires the full launch sequence `[1, 2, 3, 1]`,
captured revisions and heads, and completed waiting revisions. It checks FIFO
among ready waiting PRs and prevents the hot PR's successor from bypassing either
one. The separate pending-CI test retains coverage that a checking PR does not
block another ready PR.

The [coordination decision](../architecture/2026-10-17-foreground-review-coordination.md)
owns production admission and queue semantics. Test synchronization uses existing
dependency boundaries and does not change the scheduler or its CI refresh policy.

## Alternatives

**Accept either waiting order while retaining real delays.** This accommodates
independent CI readiness but leaves the fixture's causal ordering dependent on
the host clock and loses a direct FIFO assertion when both PRs are ready.

**Increase real delays.** A larger timing margin still depends on runner load
and extends the test without establishing which revision was observed before a
worker slot became available.

## Consequences

The test retains real SQLite and the production coordinator while making its
fairness preconditions explicit. Bounded waits observe state transitions;
elapsed wall time does not establish readiness or worker completion order.
CI refresh, pending-query bypass, and cancellation retain their separate tests.
