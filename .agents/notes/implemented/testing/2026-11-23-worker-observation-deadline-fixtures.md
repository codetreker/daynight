# Agent Note: Deliver Worker observation deadlines at the held boundary

Status: implemented

## Problem

Three tests spend ten seconds waiting while a reporter, diagnostic file handle
or prepared-command write is held by a fixture. The tests need to prove that
expiry preserves the original owner and its resources until that work joins.

## Decision

The fixtures capture the timer registered by the real deadline wrapper. They
check its original budget and deliver expiry after explicit evidence that
the original reporter close, diagnostic append and close, or prepared write
has reached its held phase. Other timers and real I/O continue normally.
The startup cases capture the management observation after actual scope stop.
The command case captures the first prepared save before any native launch.

The fixtures check the original error, ownership and lock or journal state at
expiry, then release the original writer and observe cleanup. The
[development guide](../../../../docs/development.md#cli-test-fixtures) places
these cases within CLI validation.

## Alternatives

**Wait for the entire production budget.** The held test fixtures already
control the decisive ordering. Actual elapsed time adds a fixed cost and
couples these assertions to the runner's timing.

**Use a shorter production deadline or a global fake clock.** An altered
production budget changes runtime behavior. Global clock advancement also
changes independent polling and cleanup work in the test.

## Consequences

These cases retain real descriptor, journal, process-admission and instance
lock evidence with their original ordering. Their impact on the parallel
suite depends on the actual runner schedule.
