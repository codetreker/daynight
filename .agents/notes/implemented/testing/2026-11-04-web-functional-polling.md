# Agent Note: Web Functional Polling Intervals

Status: implemented

## Problem

Functional browser journeys wait repeatedly for production polling periods even
when their assertion concerns state propagation, layout or navigation. In
[source-qualified run 41837091355](https://github.com/codetreker/daynight/actions/runs/41837091355/job/126601485011),
the execution-time journey spends about 29 seconds observing two saved-setting
changes and another 15 seconds observing the next poll after completion. The
project-graph journey spends about 42 seconds in its Session-status matrix;
server logs show eight five-second gaps while individual current-session reads
complete in milliseconds. These waits dominate otherwise short interactions.

Polling schedules, request deadlines, freshness and business elapsed time have
different meanings. A numerical timer replacement cannot distinguish them. The
Session-summary store also checks a monotonic next-read deadline on short local
ticks, so replacing a five-second timeout would not alter its refresh schedule.

## Decision

A shared module owns named task-sync and Session-summary polling periods, with
production defaults of fifteen and five seconds. Selected browser journeys
provide shorter values through a page initialization script before application
modules read them. Overrides contain only supported polling names and valid
positive timer periods. Absent names retain their defined production defaults;
invalid overrides fail visibly.

Native and container verification use the same production assets. The browser
fixture changes only its selected polling periods, retaining real Server and
Controller communication, response parsing, state publication, authentication,
layout and cleanup. Cases that control browser time and capacity measurements
retain their own schedule setup. Unit tests cover the production schedules and
short-period behavior. Assignment reconciliation also uses the short task-sync
period when an API-originated permission change must reach its open detail
control; its version-conflict, uncertain-result and exact write-count checks
retain their original assertions.

Execution elapsed time, the one-second ticker, warning thresholds, freshness and
request deadlines do not share these overrides. The execution-time journey
retains its real threshold crossing with a deliberately incorrect wall clock,
held task-sync deliveries, stable focus and unchanged geometry. Its subsequent
synchronization checks observe shorter polling through genuine responses.

The [journey timing decision](2026-11-04-web-journey-timing.md) owns raw body-step
measurements and their interpretation. The
[Web validation guide](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns commands and delivery evidence.

## Alternatives

**Replace browser timers by matching numeric delays.** Task synchronization uses
an interval, but Session refreshes use monotonic deadlines with a shorter local
tick. The same numbers also occur in failure deadlines, making a global timer
shim both incomplete and semantically broader than the intended polling change.

**Advance a simulated browser clock.** Existing deterministic scenarios keep this
technique. Applying it to the real execution crossing would remove the distinct
native-clock evidence, and installing it after native timers have started is
unsupported. Short named periods preserve natural time and the existing asset.

**Build a separate acceptance frontend.** Build-time replacement would require
both native and Docker build inputs and produce different assets. A narrow
browser injection keeps one production build path and isolates each scenario's
mock without deployment configuration.

## Consequences

Repeated polling gaps shrink while the complete scenario inventory, state
transitions and failure checks remain. Faster polling increases request frequency
within the selected tests; single-flight and concurrency behavior remain enforced.
The injection is test infrastructure, not a user-facing configuration interface.
Production-default schedule tests remain necessary because accelerated browser
journeys cannot establish the duration of a production polling period.

Measured scenario times remain tied to source, workload and environment. Removing
known waiting periods predicts local savings; only successful hosted runs provide
observed CI timing, and unrelated changes or runner variation limit comparisons.
