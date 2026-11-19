# Agent Note: Control Step Add Request Deadline

Status: implemented

## Problem

The Step Add unknown-outcome test expects one observation after a request
timeout. Both the POST and observation GET use a 20 ms request budget, so
runner scheduling can expire the GET before dispatch or while reading its
response. The [Windows failure](https://github.com/codetreker/daynight/actions/runs/44424450007/job/135226086010)
reported one fetch rather than two; it did not identify where the GET expired.

## Decision

The request-timeout case controls the timer queue and the `node:perf_hooks`
monotonic clock. It waits until the POST transport is pending before advancing
the client's request deadline, leaving the total operation budget live and the
clock fixed for the observation. The actual request timeout and recovery code
run with their original budgets. The test checks the timeout kind, POST then GET,
the recovery request identity, unknown outcome and observed absence, and restores
the operation and clocks. The response-cap case retains real time.

## Alternatives

**Increase the request budget.** Scheduling can still consume the observation
budget, and a longer real timeout adds delay without proving the intended order.

**Control only the timer queue.** The client's synchronous monotonic deadline
checks can still expire the GET independently of the timer callbacks, as in the
related [cursor deadline decision](2026-11-10-api-cursor-deadline.md).

## Consequences

The test exercises timeout recovery without depending on wall-clock scheduling;
it does not measure native timer accuracy. The separate loopback cases in
`task-steps-client.test.ts` retain real timeout coverage, and native CI still
checks the complete test on supported platforms.
