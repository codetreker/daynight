# Agent Note: Web Functional Journey Timing

Status: implemented

## Problem

A complete browser journey combines fixture commands, layout and interaction
matrices, screenshots and real synchronization waits. Its total duration does
not identify which work consumes time. The existing Playwright JSON report
already retains explicit steps for some journeys, but the attachment, task-page
and execution-time journeys lacked comparable body-level phases.

Timing diagnosis must preserve the complete functional inventory and its failure,
privacy and cleanup requirements. A long journey alone does not justify removing
assertions or changing real timer coverage.

## Decision

The three journeys express contiguous body phases with Playwright's standard
`test.step`. Attachment phases distinguish installed-CLI initialization,
standalone navigation/writes, resource and PDF rendering, preview matrices,
embedded state/focus, native scrolling and long deletion layouts. Task-page
phases distinguish discussion, bilingual task/attachment and worker-claim
layouts. Execution phases distinguish real warning crossing, saved-setting sync,
completed-duration polling and bilingual layouts.

The steps preserve the existing operations, assertions, order, timeouts and
error handling. They remain part of the same scenarios and the existing raw
`playwright.json`; there is no additional report format, performance threshold
or selected-suite entry point. The
[functional target decision](2026-11-04-web-functional-target-overlap.md)
owns target scheduling and resource isolation.

Only sibling step durations can be subtracted once from a test's total. The
remainder includes fixture/authentication setup, unwrapped actions, screenshots
outside the named blocks and teardown. It is not a measurement of fixture cost.
The pinned JSON reporter omits steps nested under fixture hooks, so shared
fixtures retain their existing code and checks. Wall time alone does not
establish CPU, I/O or scheduling causality.

## Alternatives

**Enable action or network traces.** They can expose session Cookies, PATs and
invitation contents. The existing
[authentication privacy decision](../architecture/2026-10-22-authentication-activation.md)
keeps these traces disabled; named body phases provide timing without recording
request or credential bodies.

**Add a custom reporter or timing receipt schema.** This would create another
aggregation and interpretation path even though the existing report already
stores the needed body steps. Standard steps keep the same artifact, source
identity and scenario validation.

**Treat the duration outside named phases as setup time.** It also includes
unwrapped interactions and teardown. That attribution would misidentify costs
and could lead to deleting useful validation.

## Consequences

The existing source-qualified browser artifact exposes where the three large
journeys spend their time. Timings are observations, not acceptance thresholds;
skipped, flaky, missing or incomplete scenarios still fail the original gate.
Body timings do not provide action-level profiling or fixture-hook attribution,
and comparisons retain their source, workload and runner limitations.
