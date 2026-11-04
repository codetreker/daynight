# Agent Note: Controlled Browser Clock Lifecycle

Status: implemented

## Problem

A real [Web CI run](https://github.com/codetreker/daynight/actions/runs/41872720370/job/126724057058)
exposed a clock-control failure in the Step status journey. Separate `install`
and `pauseAt` calls used the same target timestamp. Real time could advance
between those calls, making the requested pause time past even when the target
used a fixed calendar year.

Controlled phases need a deterministic clock in the document whose application
timers they inspect. Pausing an existing page does not transfer ownership of
native timers that were created before clock control began.

## Decision

Fixtures use the existing `page.clock.pauseAt` API directly before navigating to
the application, with no separate installation at the same timestamp. The
[pinned server implementation](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright-core/src/server/clock.ts#L51-L55)
initializes clock control and registers the pause state. The
[injected implementation](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/injected/src/clock.ts#L198-L209)
stops real-time advancement before applying that target.

Navigation is the application initialization barrier. The
[new-document replay](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/injected/src/clock.ts#L439-L475)
restores the paused state before the new application's timers start. The Step
status and fresh membership-page flows perform no old-application observation
between pausing and navigation. Native timers in the old page can continue until
that document is replaced; this mechanism does not retroactively control them.

Real service requests, resource convergence, membership retirement, exact write
counts, failure assertions, cleanup and existing deadlines retain their behavior.
The reopening flow still resumes time before its short polling phase. The
[functional polling decision](2026-11-04-web-functional-polling.md) owns those
selected polling periods, independently of this document lifecycle.

The execution-time scenario retains its separate native-clock evidence:
incorrect wall time, a real one-second ticker and actual warning-threshold
crossing with held task-sync responses. No simulated clock is applied to that
scenario by this decision.

## Alternatives

**Keep separate installation and pause calls at one epoch.** Clock advancement
between the calls leaves the original scheduling race. Another fixed year does
not change that ordering.

**Install before the case and use a deadline-derived future anchor.** This can
avoid the past-time race but extends controlled time across earlier application
work and adds anchor ownership. The existing atomic pause API followed by
navigation establishes the needed document boundary without those controls.

**Inspect the old page immediately after pausing.** Existing native timers may
still run there. Assertions that depend on the controlled clock belong after the
navigation barrier in the newly initialized application document.

**Raise timeouts or retry clock failures.** Longer deadlines do not make a past
timestamp valid or transfer native timer ownership. Existing assertions and
failure deadlines remain the verification contract.

## Consequences

Controlled application documents start with replayed clock ownership and paused
state. Local browser probes establish the fixed date, timer boundary, resume and
fresh-context behavior; they also expose the old-page native timer limitation.
Complete selected native/container suites and current-source Web CI remain
necessary to prove resource and application integration after navigation. The
API behavior and earlier failure alone do not establish that full result.
