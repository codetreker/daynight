# Agent Note: Worker Ownership Refusal Test Budget

Status: implemented

## Problem

The ownership refusal test prepares a real managed worktree, checks foreign
claim and project refusals, removes the owned worktree, and checks that a
nonempty unmarked reservation is rejected without losing its contents. Its
default five-second watchdog covers that complete native workflow.

Windows [run 42727240878](https://github.com/codetreker/daynight/actions/runs/42727240878/job/129539302986)
reported 5,245 ms and failed that watchdog. The same source passed in 3,772 ms
in the preceding main run. Neither log identifies the command active at expiry.
A case-scoped measurement records 41 real manager Git calls, plus eight cold
fixture and seed commands. With 150 ms of controlled overhead per manager call,
the original watchdog expires before the assertions finish; the complete
workflow finishes in about 6.6 seconds with its own longer bound.

## Decision

The ownership refusal case in
[`worktrees.test.ts`](../../../../packages/daynight/test/commands/worker/worktrees.test.ts)
owns a 30-second watchdog, matching the complete concurrent-fetch workflow's
existing allowance. Every real preparation, refusal, removal and content
assertion remains inside the test. Production Git and Operation deadlines remain
independent. Cases without an explicit budget retain the five-second default.

The [development guide](../../../../docs/development.md) owns fixture usage.
The [concurrent fetch decision](2026-11-09-worker-concurrent-fetch-budget.md)
records that separate interleaving's budget and assertions.

## Alternatives

**Keep the default watchdog.** The observed Windows case exceeds it. Controlled
command overhead reproduces the failure while the real workflow remains healthy.

**Remove real preparation or move it outside the measured workflow.** The
refusals depend on a real claim-owned registration and successful removal before
the nonempty unmarked reservation is constructed. Preserving that sequence keeps
the intended ownership and content protection checks together.

**Raise the global or file-wide timeout.** Unrelated cases do not share this
full command sequence. Their existing failure bounds remain useful.

## Consequences

The test allows native subprocess overhead while retaining finite hang detection
and all ownership checks. A controlled ownership-guard mutation still fails the
foreign-claim assertion. This does not identify a production Git defect or prove
which native command consumed the failing Windows run's time.
