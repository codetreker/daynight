# Agent Note: Worker Recovery and Origin Test Budgets

Status: implemented

## Problem

Two Worker worktree tests execute complete native Git workflows under the
runner's default five-second watchdog. One reconciles a successful administrative
removal whose response is lost, retries removal, prepares a new claim at the
same path, and checks that the old claim cannot remove its contents. The other
changes a worktree-local origin, rejects execution and preparation, and checks
that terminal cleanup still removes the owned registration.

Windows [run 42741465672](https://github.com/codetreker/daynight/actions/runs/42741465672/job/129583390623),
from clean source `5e108ce59a328c3d8005add697431a7956283abe`, reports 5,359 ms
and 5,180 ms respectively, with both failing the 5,000 ms watchdog. The log does
not identify the Git command active at expiry. The
[ownership refusal budget](2026-11-10-worker-ownership-refusal-budget.md)
introduced by PR #958 covers a separate case.

Case-scoped wrappers count 43 and 39 real manager Git calls. With 150 ms of
controlled overhead before each call, the original watchdog fails at 5,023 ms
and 5,028 ms; the longer case budgets let every original assertion complete at
6,884 ms and 6,254 ms. Unmodified local cases take 328 ms and 315 ms. These
controlled measurements explain how native command overhead can exceed the
original allowance; they do not reproduce the original Windows command timing.

## Decision

Only the lost administrative-removal response and changed task-local origin
cases in
[`worktrees.test.ts`](../../../../packages/daynight/test/commands/worker/worktrees.test.ts)
each own a 30-second watchdog, matching the existing complete native Worker
workflows. All real preparation, recovery, refusals, cleanup and assertions stay
inside their original test bodies. Other cases without an explicit budget retain
the five-second default. Production Git and Operation deadlines are independent.

The [development guide](../../../../docs/development.md) owns fixture usage.

## Alternatives

**Keep the default watchdog.** The observed Windows workflows exceed its bound
before their assertions finish.

**Raise the file or global timeout.** The two observed failures do not establish
that unrelated cases need a larger budget. Their existing failure bounds remain
useful.

**Remove real Git preparation or move it outside the case.** These cases depend
on actual ownership registrations, removal results and worktree configuration.
Keeping their sequence together preserves the mechanisms and assertions that
the tests own.

## Consequences

The two cases allow native subprocess overhead while retaining finite hang
detection and the complete original checks. A hung case can now take up to 30
seconds to fail. The timeout evidence does not establish a production Git defect
or identify which command consumed the failing Windows run's time. Temporary
claim-comparison and worktree-origin validation mutations still fail the
original rejection assertions; the probes and mutations are excluded from the
delivered source.
