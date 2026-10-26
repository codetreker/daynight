# Agent Note: Deterministic Cooldown Deadline Tests

Status: implemented

## Problem

Cooldown tests used short wall-clock deadlines while waiting for unrelated
asynchronous work. A valid retry could occur after the deadline but before the
test reached its assertion, making correct scheduling appear to violate the
cooldown. The [main CI failure](https://github.com/codetreker/daynight/actions/runs/39378801315)
observed two repository scans where the test expected one.

The failed test set its deadline to Date.now() plus 150 milliseconds before
startup, then waited for three scans of another repository. That wait did not
guarantee completion before the deadline. A bounded diagnostic reproduced the
failure with one 200-millisecond event-loop stall: the barrier completed at
252 milliseconds and subsequent limited-repository calls were after the
deadline. The hosted log does not identify a particular source of scheduling
delay. Both coordinator code and its test were unchanged between the W-T1
baseline and the W-T2 merge.

## Decision

The three coordinator cooldown scenarios use the existing injected clock.
Logical time advances only after observed scan, persistence or review-completion
barriers. Tests require suppression at retryAt minus one and successful progress
at retryAt itself, preserving other-PR or other-host progress and attempt budgets.
Real SQLite and asynchronous coordinator execution remain in the tests.

The repository case uses a genuinely distinct second host. It also fails after
the open list has returned a new PR but while an older PR's detail is read.
Before expiry, the old snapshot and successful poll time remain, the new PR is
absent, and the API error remains visible. At expiry, the complete observation
commits and clears the error. The prelaunch case preserves the captured review,
session and worktree while the worker slot is available to another PR.

The [coordination decision](../architecture/2026-10-17-foreground-review-coordination.md)
owns production scheduling. This extends the
[controlled-clock validation](../testing/2026-10-19-deterministic-coordinator-fairness.md)
to deadline boundaries; product scheduling, request cooldown policy, timeouts,
native workload and required CI jobs are unchanged.

## Alternatives

**Increase the real-time cooldown window.** A larger window still assumes a
bound on unrelated host scheduling and does not establish the deadline ordering.

**Replace all fixture timers with fake timers.** The fixture also owns real
SQLite, promise completions and bounded waits. Controlling the coordinator's
existing logical clock keeps those real boundaries visible without replacing
their scheduling mechanism.

## Consequences

The assertions prove before/at-deadline behavior rather than elapsed test speed.
Snapshot atomicity and independent progress have explicit state barriers. The
failing workflow remains an incident record; delivery requires a changed-source
native CI pass, not an unchanged rerun.
