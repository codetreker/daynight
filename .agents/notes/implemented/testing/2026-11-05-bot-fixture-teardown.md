# Agent Note: Bot Fixture Teardown Isolation

Status: implemented

## Problem

A real Bot lifecycle fixture retains an original Controller after an uncertain
spawn observation. Its cleanup can spend ten seconds waiting for that child's
process proof before joining IPC, process-tree confirmation and resource release.
The ordinary ten-second Vitest hook deadline can expire during that work.

[Vitest's timeout wrapper](https://github.com/vitest-dev/vitest/blob/7a825db43e2beca0b219d2eadaec334cb81af0c7/packages/vitest/src/runtime/runner/context.ts#L37-L115)
rejects the runner's wait without cancelling an asynchronous callback that does
not observe its signal. The next test can therefore start before the earlier
hook restores mocks and environment variables. Configuration helpers resolve
`DN_CONFIG_DIR` at each call, while a prepared child environment retains its
fixture directory. Late restoration can separate parent ticket and journal paths
from the child's paths even when both have an explicit home directory.

## Decision

The real Bot integration file owns a separate 180-second teardown hook budget.
It covers the thirty-second durable-proof observation, cooperative IPC stop,
original-process observation, Windows Job termination, final confirmation and
failure diagnostics for the controlled Controller and native process. Startup
identity acquisition retains fifteen seconds on Windows and five seconds on
POSIX; recurring identity probes retain five seconds and Job Object probes
retain fifteen seconds. Windows proof acquisition uses the
[native process handle](../bug-fix/2026-11-05-windows-native-process-proof.md)
implementation, whose deadline checks join native calls without preempting a
kernel call. The separate
[startup budget decision](../bug-fix/2026-11-05-windows-startup-process-proof-budget.md)
owns the caller allowances; this hook does not set production launch or stop
deadlines.

Process confirmation is polled sequentially, joining each system probe before
starting another or escalating. A polling deadline limits another round; an
already started probe retains its per-call bound. Native proofs observed before
and after shutdown are deduplicated by original process identity before cleanup.
No timeout race releases fixture ownership while its cleanup continues.

Only the owning fixture's controlled startup logs, launch records, journal state
and parent/child ticket paths are diagnosed. Log reads are bounded and marked
when truncated. Startup and cleanup failures remain failures; unknown process
ownership retains the fixture's evidence instead of authorizing deletion.

## Alternatives

**Keep the ten-second hook and race cleanup against it.** This releases the next
test while cleanup still owns global mocks and environment restoration. An
outer timeout alone does not cancel those effects.

**Increase every CLI hook deadline.** Other test files do not share this real
Controller teardown sequence. A file-owned budget preserves their existing
limits and makes the resource owner responsible for its longer cleanup.

**Change production process-query deadlines.** A hosted Windows query timeout
was observed, but the missing first child journal did not establish its startup
cause. Altering product deadlines would not repair teardown isolation. Original
startup diagnostics preserve the evidence needed to reconsider that policy.

## Consequences

The hook waits for bounded owned cleanup before restoring globals. A regression
holds teardown beyond the former ten-second limit and checks that the following
fixture's parent ticket path still agrees with its frozen child configuration.
The extra delay belongs to this regression, not normal successful teardown.

The hook budget is distinct from the production stop deadline. Joined probes can
finish after a polling deadline, so that deadline is not a strict wall-clock
limit. Missing ownership still prevents deletion. Failure evidence can explain
an unavailable original Controller without manufacturing a successful startup
or attributing every system timeout to a product defect.
