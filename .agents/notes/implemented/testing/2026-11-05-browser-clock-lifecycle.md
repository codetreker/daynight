# Agent Note: Controlled Browser Clock Lifecycle

Status: implemented

## Problem

A real [Web CI run](https://github.com/codetreker/daynight/actions/runs/41872720370/job/126724057058)
exposed a clock-control failure in the Step status journey. The case installed a
controlled clock after application timers had started, then paused at the same
timestamp used for installation. Playwright replaces native clock functions, so
late installation can leave existing timers under a different owner. Its running
clock can also pass the installation timestamp before the subsequent pause call.

The [pinned Playwright lifecycle requirement](https://github.com/microsoft/playwright/blob/ce480a952553175eae75342aad2c5e86cdf2cbba/docs/src/clock.md#L22-L39)
requires installation before other clock-related calls. A fixed calendar year
alone does not prevent an identical installation/pause anchor from becoming past.

## Decision

The controlled Step status case installs its clock at entry, before navigation
to the production application. Its later reopening phase pauses at
`clockStart + info.timeout`. This anchor remains in the future within the case's
existing deadline, without introducing another timing budget or arbitrary year.
The membership-revocation flow applies the same order and bounded future anchor
to its newly created page before application navigation.

The real service, resource convergence, membership retirement, exact write
counts, failure assertions, cleanup and existing deadlines retain their behavior.
The reopening flow still resumes time before its short polling phase. The
[functional polling decision](2026-11-04-web-functional-polling.md) owns those
selected polling periods; it does not change clock ownership.

The execution-time scenario retains its separate native-clock evidence:
incorrect wall time, a real one-second ticker and actual warning-threshold
crossing with held task-sync responses. This controlled-clock lifecycle does not
apply a simulated clock to that scenario.

## Alternatives

**Install only when the reopening phase begins.** The application has already
created timers at that point. Replacing global clock functions then violates
the documented lifecycle even when a particular run happens to complete.

**Pause at the installation timestamp or another fixed year.** Time advances
between the two calls; choosing a different year leaves the same ordering race.
A future anchor derived from the existing case bound removes that dependency.

**Raise timeouts or retry clock failures.** Longer deadlines do not establish
correct clock ownership or make a past timestamp valid. The existing assertion
and deadline boundaries remain the verification contract.

## Consequences

Controlled phases use one clock owner before application initialization, and
pause without depending on zero elapsed scheduling time. Browser navigation,
periodic synchronization and resumption still require real execution evidence.
A focused clock probe establishes the local primitive behavior; complete selected
native/container browser suites and current-source Web CI establish integration.
The earlier failure and the lifecycle record do not themselves prove the repair.
