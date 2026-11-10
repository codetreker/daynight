# Agent Note: Control API Cursor Deadline Progression

Status: implemented

## Problem

A continuously advancing API cursor must not renew an operation's total
deadline. The regression test used a real 35 ms operation budget and a 5 ms
sleep for every mocked response, then required multiple pages to complete.
Correct deadline enforcement can expire during the first response when runner
scheduling and response processing consume that budget, leaving the intended
cross-page behavior untested.

The [Windows failure](https://github.com/codetreker/daynight/actions/runs/42699523976/job/129440385415)
at [the fixed source](https://github.com/codetreker/daynight/blob/b2b25d601f5a90a584761bb516380e186506ea78/packages/daynight/test/api/client.test.ts#L591-L605)
reported one completed mocked response against the multiple-page assertion.
That observation establishes the fixture's scheduling vulnerability; it does
not identify the exact delayed stage or a Windows runtime defect.

## Decision

The fixture freezes `setTimeout` and `clearTimeout` and controls
`performance.now` imported from `node:perf_hooks`, following the clock boundary
used by the [attachment deadline fixture](2026-11-07-attachment-sink-deadline.md).
Each dispatched response advances monotonic time by 10 ms. With the original
35 ms total limit and 100 ms request limit, three pages pass through the real
client and the fourth response crosses the shared total deadline.

The test requires the deadline error, four dispatched responses, the exact
advancing cursor sequence, unique cursors and at most one outstanding response.
The response fixture rejects an unexpected fifth fetch so missing or renewed
total deadlines fail promptly. The real operation, request lifecycle, response
reading and pagination execute unchanged; the existing teardown disposes the
operation and restores mocks and native timers even after assertion failure.
The [development guide](../../../../docs/development.md#cli-test-fixtures) owns
fixture usage guidance.

## Alternatives

**Increase the real deadline.** A larger allowance still leaves page count
subject to scheduler delays and makes a deterministic semantic assertion slower.

**Control timers without the monotonic clock.** Synchronous remaining-time
checks can expire independently of paused timer callbacks, so delayed setup
would still consume the multi-page budget.

**Accept a timeout after one page.** This loses proof that continuously advancing
cursors share an operation deadline across multiple successful pages.

## Consequences

The shared-budget proof no longer requires multiple responses to fit within a
short wall-clock interval. It retains the original limits and failure category,
and makes cursor progression explicit. Frozen callbacks exercise synchronous
remaining-time enforcement; the surrounding deadline and cancellation cases
retain their separate timer and signal responsibilities. Native platform CI
remains necessary for the complete CLI suite.
