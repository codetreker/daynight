# Agent Note: Pending-status navigation test budget

Status: implemented

## Problem

The authenticated pending-status navigation case mounts the real application,
opens three details, changes focus and attachment selection, navigates P/Q/P,
and publishes a held mutation. Its complete workload can exceed the default
five-second test timeout even when all behavior and readiness checks succeed.
Two Web CI runs reported that outer timeout. Their logs do not establish the
exact historical runner scheduling or the interrupted operation.

## Decision

Only the complete P/Q/P case in `auth-status-session.test.tsx` has a 15-second
outer test timeout. Its real UI, authentication, routing, IndexedDB, cache and
session collaborators, assertions and individual readiness bounds remain in
place. This bounded total workload budget is not a product request or status
publication deadline. The separate [identity observation decision](2026-11-07-identity-test-observation-boundaries.md)
retains the rationale for its observation and query boundaries.

## Alternatives

**Keep the default outer timeout.** Under a controlled two-CPU, four-worker
coverage run the original case timed out, while an instrumented complete run
passed in about 7.5 seconds and released the mutation in about 3 milliseconds.
The default budget can truncate a functioning full flow.

**Optimize queries and fixture setup or isolate the sidebar.** Tested query and
preference adjustments still produced overlapping passes and timeouts near five
seconds. Sidebar isolation reduced the observed cost once but left little margin
and narrowed the real UI boundary.

## Consequences

The case has bounded scheduling margin without changing other cases or global
timeouts. A representative disabled-status mutation still failed at the same
behavior assertion under both budgets. Longer complete runs do not establish a
performance change relative to a truncated failure, nor do the controlled
measurements prove the exact scheduling of historical CI failures.
