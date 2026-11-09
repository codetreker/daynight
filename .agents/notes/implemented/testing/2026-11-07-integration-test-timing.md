# Agent Note: Bound Integration Test Timing With Instance Intervals

Status: implemented

## Problem

Integration tests for upload renewal failure and search timeouts must exercise real cancellation and failure handling. Waiting for production intervals makes those tests slow even though the length of the interval is not the behavior under examination.

## Decision

Upload services and search handlers hold their timing intervals per instance. Production construction retains the 20-second upload renewal interval and five-second search deadline. Tests select shorter intervals and retain actual timer expiration. The upload test waits for storage opening before injecting a renewal failure and checks the failure and unpublished outcome. The PostgreSQL search test observes its query active before accepting deadline cancellation. Completion failure tests wait for the real expired context before returning their errors.

The [snapshot cancellation decision](2026-11-06-snapshot-cancellation-observation.md) owns the corresponding PostgreSQL transaction tests.

## Alternatives

**Keep production intervals in tests.** This exercises the same paths but adds fixed waits unrelated to their cancellation and outcome guarantees.

**Return synthetic timeout errors.** This would not prove that the real operation context expired or that cancellation interrupted an active query.

## Consequences

The tests retain real asynchronous timers, database queries, and failure paths while shortening incidental waits. Instance configuration avoids a mutable package-wide timer shared by concurrent tests. Observation may fail under severe scheduling delays rather than treating an early timeout as proof of query cancellation.
