# Agent Note: Prelaunch Target Capture Barrier

Status: implemented

## Problem

Waiting-admission refreshes and captured prelaunch CI checks share the same
GitHub client operation. A race test that changes the PR head after the second
global check does not establish that the old target has been reserved. If that
check is another admission refresh, retaining only the new completed review is
valid: superseded history requires an existing captured review.

## Decision

The [coordinator test](../../../../packages/daynight/test/commands/review/coordinator.test.ts)
holds the old revision in the existing worktree-preparation callback. It checks
the persisted preparing review and its reservation event before releasing
preparation, then holds the old target's actual prelaunch CI request. Only after
that request is pending does it advance the head and release the old CI response.

The case runs with zero and two preceding unready admission responses. Those
responses exercise waiting refreshes without using a global call number to
identify prelaunch. The original new-head-only launch, completed revision and
superseded/completed history assertions remain, together with explicit
old/new preparation order. Both deferred gates are released in `finally` so a
failed assertion cannot strand coordinator shutdown.

The [development guide](../../../../docs/development.md#validation) owns the
validation method. Coordinator scheduling, target coalescing, product interfaces,
polling and all test deadlines retain their existing behavior.

## Alternatives

**Count global CI requests.** A second request can still be an admission refresh
before any persisted reservation. Its position does not identify a captured
target or justify superseded history.

**Delay the head change.** A fixed sleep would only make reservation more likely
and would leave the phase assumption dependent on host scheduling. The existing
preparation callback and persisted state provide causal evidence directly.

**Accept completed-only history.** That would remove the assertion proving that
an already captured old revision was superseded after its asynchronous check.
The test establishes the prerequisite and retains the stronger assertion.

## Consequences

The race is exercised after a real old-target reservation under both admission
patterns. It still requires a superseded old review and one completed new review,
and the old head must never launch. Fixture state and asynchronous requests stay
private to each case. No product phase field or synchronization framework is
introduced, and extra admission refreshes add only their existing polling work.
