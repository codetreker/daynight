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
implementation. Job operations use the
[native Job API](2026-11-05-native-controller-job-api.md) with the same fifteen-second
operation budget. Both implementations check deadlines between native calls and
join a call already in progress without preempting the kernel. The separate
[startup budget decision](../bug-fix/2026-11-05-windows-startup-process-proof-budget.md)
owns the caller allowances; this hook does not set production launch or stop
deadlines.

Process confirmation is polled sequentially, joining each system probe before
starting another or escalating. The soft polling window limits another round;
it is not passed as a confirmation deadline. An already started confirmation
retains the production per-query budgets and joins native work already in
progress. A controlled clock and barrier verify both stopped and still-running
results across that window, without starting another probe after it expires.
Native proofs observed before
and after shutdown are deduplicated by original process identity before cleanup.
No timeout race releases fixture ownership while its cleanup continues.

Darwin can expose a discarded command as `(node)` while the original process
still has a non-exiting status. The complete-stop check reports a typed identity
conflict, including its PID and mismatch fields, and never confirms that
observation as stopped. The fixture may reobserve this specific conflict within
its existing deadline, without signaling the uncertain process. Only a later
complete Controller, native-process and group or Job proof permits success;
persistent conflicts and unrelated observation failures remain errors.

Only the owning fixture's controlled startup logs, launch records, journal state
and parent/child ticket paths are diagnosed. Log reads are bounded and marked
when truncated. Startup and cleanup failures remain failures; unknown process
ownership retains the fixture's evidence instead of authorizing deletion.

The isolation regression uses a 100-millisecond fallback deadline only while
registering this hook, whose explicit budget remains 180 seconds. This is the
file's first runtime configuration override, so Vitest snapshots the inherited
configuration for `vi.resetConfig()`. Vitest captures the fallback when registering
a hook; the inherited configuration is restored immediately afterward, including
when registration throws. Other hook and test registrations retain their
existing defaults. The synthetic cleanup schedules its completion 25 milliseconds
past the fallback and signals completion. The next case prepares its own
environment and mock, joins that signal, and yields an event-loop turn so that
the earlier hook has an opportunity to restore globals. If the explicit budget
is removed, Vitest can start the next case after the fallback expires while
the earlier hook still owns restoration. Its late restoration then invalidates
the next case's parent/child ticket paths and mock.

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

**Use the polling window as each confirmation deadline.** A probe launched near
the end receives only the remaining fraction of the window, so an ordinary end
of polling can instead surface as a query failure even after escalation confirms
stop. Increasing the window would not remove that coupling.

**Keep the original eleven-second cleanup and 1.5-second observation.** Those
waits originally crossed the ordinary ten-second hook limit and exposed late
global restoration. The same ordering follows from a registration-local default
and shorter synthetic waits, without adding 12.5 seconds to every file run.

**Shorten only the waits or change the default during execution.** Short waits
under the ordinary ten-second fallback cannot expose a missing explicit budget.
Changing the default in a runtime hook is too late because the timeout wrapper
already captured it at registration.

**Wait a fixed interval before observing the next case.** The earlier 350 ms
observation delay gave the 300 ms synthetic cleanup time to finish. A completion
signal and event-loop turn preserve the ordering even when scheduling varies and
reserve the timed portion for crossing the captured hook deadline.

## Consequences

The hook waits for bounded owned cleanup before restoring globals. The adjacent
regression cases still cross a real captured fallback and observe the prepared
child's ticket path alongside the parent's path and mock value. Joining the
synthetic completion signal makes the regression sensitive to the ordering of
restoration. Process observations and production deadlines retain their native
bounds.

The hook budget is distinct from the production stop deadline. Joined probes can
finish after a polling deadline, so that deadline is not a strict wall-clock
limit. Missing ownership still prevents deletion. Failure evidence can explain
an unavailable original Controller without manufacturing a successful startup
or attributing every system timeout to a product defect.
