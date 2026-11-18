# Agent Note: Reconcile Wake Poll Fixture

Status: implemented

## Problem

The reconcile wake poll case installed fake global timers, but the mocked
`node:timers/promises` function delegated to its original native delay. It
consumed the full second and did not verify the interval passed to the timer.
A [macOS CI sample](https://github.com/codetreker/daynight/actions/runs/44243743660/job/134600298999)
reported 1.009 seconds for the test file.

## Decision

The [wake test](../../../../packages/daynight/test/commands/worker/reconcile-wake.test.ts)
keeps the first native wait and real wake. The second wait supplies one
controlled, abortable promise, requires the requested 1,000 ms and signal,
and resolves only after the parent verifies the wait is pending. Other cases
still exercise real native cancellation and preserve the original stop reason.

## Alternatives

**Use a short native delay.** This would tie the pending observation to real
scheduling and would not verify the unchanged interval passed by the caller.

## Consequences

The file no longer pays the idle second during a successful run. The wake,
error, and cancellation contracts remain distinct, and production timing is
unchanged.
