# Agent Note: Native Git Cleanup Evidence

Status: implemented

## Problem

A cancellation test that always expects only the operation error conflates
physical disappearance of its known child with the native termination tool's
confirmation of the whole process tree. A completed Windows `taskkill` call can
return nonzero even when that child has already stopped. The runtime must retain
that tool failure, while a test must verify both the diagnostic and the physical
outcome of its owned fixture.

The runtime already aggregates cleanup failures with the operation error as
cause in [the original PR #47 implementation](https://github.com/codetreker/daynight/blob/edfefb2f36a8cbcf223e5ae1df1bb120b2231d15/packages/daynight/src/repository/git.ts#L84-L116).
That predates the CI optimizations. The
[Git execution design](../../../../docs/design/daynight-project-task.md#git-定位与仓库身份)
requires bounded termination and an explicit unconfirmed result when cleanup
cannot be established; wrapper closure alone does not prove descendant exit.

The controlled descendant publishes readiness before starting its heartbeat.
A ready marker and live PID do not establish that the descendant's timer has
run. Its former fixed 50ms heartbeat observation could therefore fail without
proving that the descendant stopped; the
[release preparation failure](https://github.com/codetreker/daynight/actions/runs/40053873708/job/120752443773)
reported no observed heartbeat growth in that window. Positive evidence of
continued execution requires observing actual progress within a bounded period.

## Decision

The real Git-alias cancellation test transparently observes the actual system
`taskkill.exe` invocation. Its forwarding capture executes the original native
function, returns its actual result or rethrows the same error object. A
successful tool return requires the exact operation cancellation reason. A
completed finite nonzero status, with no launch code, timeout or termination
signal, requires an `AggregateError` whose `errors` array contains exactly the
captured native error object and whose `cause` is the exact operation reason.
Missing, ambiguous or additional errors fail the test.

Both Windows outcomes still require the known Node PID to be gone, its tick file
to stop changing and cancellation to complete within the unchanged 2,500ms bound.
Readiness, fixture cleanup and test deadlines retain their existing limits. This
aligns error-protocol assertions with the existing runtime contract while keeping
physical termination assertions independent and mandatory. Production behavior,
dependencies and platform support remain unchanged.

A separate [controlled cleanup suite](../../../../packages/daynight/test/repository/git-cleanup.test.ts)
uses a real Node wrapper and a detached descendant with ignored stdio. Its
injected termination boundary distinguishes a confirmed child cleanup from an
uncertain result that closes only the wrapper. In the uncertain case the wrapper
really closes while the child remains alive and continues ticking; the runtime
must preserve the exact cleanup error and cancellation cause. The confirmed case
requires actual descendant exit and stable ticks. Every path reaps the owned
wrapper and descendant in `finally`.

After confirming wrapper closure and the uncertain descendant's live PID, the
controlled suite captures a heartbeat baseline. It polls every 10ms for at most
1,000ms for the tick file to grow beyond that baseline. A descendant that makes
no progress still fails. Immediate heartbeat cases cover both termination
outcomes; an additional uncertain case delays heartbeat startup by 250ms after
readiness, exercising the observation independently of the former 50ms window.
The unchanged 2,500ms cancellation assertion precedes heartbeat observation, so
waiting for progress does not expand the cancellation budget.

The [native alias test](../../../../packages/daynight/test/repository/git.test.ts)
retains the real platform operation; the controlled suite establishes why root
closure cannot substitute for tree confirmation. Their evidence scopes remain
separate.

## Alternatives

**Ignore `taskkill` status 255 in the runtime.** One fixture's disappeared child
does not establish that every owned descendant exited. Suppressing that native
failure would weaken the pre-existing unconfirmed-termination diagnostic and
hide its cause.

**Treat wrapper closure as successful tree cleanup.** A detached child with
ignored stdio can survive after the wrapper closes and all its pipes finish.
The controlled fixture makes that survival observable, so root closure cannot
supply the missing tree evidence.

**Lengthen the fixed heartbeat sleep.** A larger delay still assumes when the
other process receives execution time and spends the full delay even when
progress is already observable. Bounded polling requires the same positive
heartbeat evidence and ends as soon as that evidence is available.

**Replace cancellation with a native Windows Job Object integration.** This
would change runtime ownership, dependencies and platform support beyond the CI
test-contract repair. The existing runtime already preserves uncertain cleanup;
conformance tests can verify that behavior without adding a native bridge.

## Consequences

The test accepts only the exact diagnostic corresponding to the observed native
tool outcome and still proves that its own alias child stopped. Genuine tool
launch failures, timeouts, signals and additional cleanup failures remain test
failures. No arbitrary aggregate error or silent native failure is accepted.

Controlled liveness evidence now depends on observed heartbeat progress, with a
one-second upper bound, rather than the descendant receiving execution time
within 50ms. Delayed heartbeat startup exercises that distinction while the
confirmed case still requires actual exit and stable ticks. A stalled or stopped
uncertain descendant remains a test failure.

Controlled Node-process evidence does not establish a successful native Windows
run. Hosted results remain tied to the tested head and actual platform, and
runtime uncertainty remains visible even when a fixture can independently prove
that its known child has exited.
