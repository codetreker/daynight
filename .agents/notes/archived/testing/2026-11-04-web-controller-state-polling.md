# Agent Note: Web controller state polling

Status: implemented

## Problem

Task controller tests wait for asynchronous reads, writes and reconciliation
without mounting a DOM. Testing Library checks assertions immediately, then
retries on DOM mutations or its default 50ms interval. Controller state updates
do not produce DOM mutations, so successive waits accumulate unrelated idle time.

## Decision

The platform, pause, status and assignment session suites use
`packages/daynight-web/tests/helpers/waitForState.ts`. The helper delegates to
React Testing Library's `waitFor` with a 5ms default interval. Its original
generic signature and explicit options remain available, including interval and
timeout overrides. Immediate assertions, asynchronous callbacks, timeout errors,
mutation observation and cleanup remain owned by Testing Library.

The helper is opt-in for these controller suites. Their assertions, test cases,
event-loop yields and deadlines remain intact. DOM tests retain their existing
waits, and product polling remains unchanged. The [Web validation guide](../../../../packages/daynight-web/README.md#development)
owns the commands and coverage requirements.

## Alternatives

**Keep the 50ms default.** Each pending controller assertion may wait for the next
poll even when the state changes promptly. Repeated state transitions need no
such minimum elapsed time.

**Poll every millisecond.** A local probe demonstrated avoidable waiting, but
that cadence requests five times as many checks as 5ms while an assertion remains
pending. Five milliseconds reduces the original delay with fewer checks.

**Wait through controller subscriptions.** Subscriptions could remove polling,
but a separate waiter would own immediate checks, asynchronous assertions,
deadlines, error reporting and listener cleanup. Delegating to the existing
waiter preserves those semantics for this cadence adjustment.

## Consequences

The affected suites observe ready state sooner without shortening their failure
budgets. Polling can execute more assertions during a slow operation; the 5ms
cadence is limited to the four controller suites. Local case and subset durations
do not establish whole-job savings under parallel workers. Changes to callback
cost or suite composition require fresh measurement.
