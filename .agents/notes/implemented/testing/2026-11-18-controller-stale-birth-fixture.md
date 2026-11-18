# Agent Note: Controller Stale Birth Fixture

Status: implemented

## Problem

The Controller PID-reuse test waited 2.2 seconds to distinguish two process
birth times on platforms where `ps` rounds to seconds. It already simulated
reuse by using the old proof with a different process's PID. The delay did not
prove that the operating system actually recycled a PID. A
[macOS CI sample](https://github.com/codetreker/daynight/actions/runs/44243743660/job/134600298999)
reported 2.534 seconds for the case.

## Decision

The [launch observation test](../../../../packages/daynight/test/commands/controller/launch-observation.test.ts)
captures a real child and uses its exact live identity with only the saved
birth replaced by an old value in the native platform format. Reconciliation,
stop refusal, process inspection, and fixture cleanup remain real. The test
isolates the birth fence because the command, PID, parent, and group match.

## Alternatives

**Wait for a short wall-clock interval or for actual PID recycling.** The
former remains dependent on native time precision; the latter is neither
bounded nor needed to exercise a stale proof against a real live process.

## Consequences

The case no longer needs a second process or a fixed interval. It still
demonstrates that the real live process is not mistaken for the original or
stopped. Production process detection and deadlines are unchanged.
