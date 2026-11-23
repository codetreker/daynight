# Agent Note: Control Step Add Request Deadline

Status: implemented

## Problem

The Step Add unknown-outcome test expects one observation after a request
timeout. Both the POST and observation GET use a 20 ms request budget, so
runner scheduling can expire the GET before dispatch or while reading its
response. The [Windows failure](https://github.com/codetreker/daynight/actions/runs/44424450007/job/135226086010)
reported one fetch rather than two; it did not identify where the GET expired.

## Decision

The original request-timeout case controlled the timer queue and the
`node:perf_hooks` monotonic clock. It waited until the POST transport was pending
before advancing
the client's request deadline, leaving the total operation budget live and the
clock fixed for the observation. The actual request timeout and recovery code
ran with their original budgets. The test checked the timeout kind, POST then GET,
the recovery request identity, unknown outcome and observed absence, and restored
the operation and clocks. The response-cap case retained real time.

The [CLI retirement](../simplification/2026-11-23-retire-cli-task-steps.md)
removes the Steps client and its dedicated deadline cases. The timer and monotonic
clock technique remains relevant to bounded recovery tests for surviving APIs.

## Alternatives

**Increase the request budget.** Scheduling can still consume the observation
budget, and a longer real timeout adds delay without proving the intended order.

**Control only the timer queue.** The client's synchronous monotonic deadline
checks can still expire the GET independently of the timer callbacks, as in the
related [cursor deadline decision](2026-11-10-api-cursor-deadline.md).

## Consequences

The test exercised timeout recovery without depending on wall-clock scheduling;
it did not measure native timer accuracy. Separate loopback cases in the former
Steps client suite provided real timeout coverage while that client was supported.
