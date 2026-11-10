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
starting another or escalating. A polling deadline limits another round; an
already started probe retains its per-call budget and joins native work already
in progress. Native proofs observed before
and after shutdown are deduplicated by original process identity before cleanup.
No timeout race releases fixture ownership while its cleanup continues.

Only the owning fixture's controlled startup logs, launch records, journal state
and parent/child ticket paths are diagnosed. Log reads are bounded and marked
when truncated. Startup and cleanup failures remain failures; unknown process
ownership retains the fixture's evidence instead of authorizing deletion.

Directory-removal failures record the original Controller's native `exit` and
`close` observations, retained process identities and Windows Job membership
after the stop gate. A fixture-local observer forwards the actual spawn
unchanged and matches its PID to the durable Controller proof.

A Windows handle-observation child starts before the Controller, with its cwd
outside the private fixture directory. The first removal failure triggers its
snapshot before asynchronous identity or Job rechecks can let a brief handle
disappear. It observes file handles across Windows processes, including the
Vitest process, and emits only exact target-path matches with access, handle
race and query-error counts. The implementation follows Microsoft's
[File Locksmith handle enumeration](https://github.com/microsoft/PowerToys/blob/ccd0473af8b8ab266c1b9861f928d4b85dffa291/src/modules/FileLocksmith/FileLocksmithLibInterop/NtdllExtensions.cpp#L351-L436).

Native name queries can block, so they run in that separate child under a hard
deadline with termination and joined closure. Duplicated handles can retain the
file object's sharing reservation; every copy and the trace child must close
before the subsequent after-Controller-close removal probe. The original removal
failure remains a failure even if that probe succeeds.

A matching PID and handle identifies an open-handle candidate. The snapshot
does not reveal `FILE_SHARE_DELETE`, and inaccessible or raced handles prevent
an absence conclusion. A focused Windows regression establishes the causal
control: another process opens the real directory without delete sharing,
removal fails with `EBUSY`, the trace identifies that process, and removal remains
blocked until the holder explicitly releases its handle. This validates the
observation mechanism without attributing an earlier CI failure to that fixture
holder or to a production process defect.

The isolation regression uses a 100-millisecond fallback deadline only while
registering this hook, whose explicit budget remains 180 seconds. This is the
file's first runtime configuration override, so Vitest snapshots the inherited
configuration for `vi.resetConfig()`. Vitest captures the fallback when registering
a hook; the inherited configuration is restored immediately afterward, including
when registration throws. Other hook and test registrations retain their
existing defaults. The synthetic cleanup waits 300
milliseconds and the following case observes its environment, mock and ticket
path after 350 milliseconds. If the explicit budget is removed, the runner can
start that case at the short fallback deadline while the first cleanup still
owns global restoration. Its late restoration is then visible to the following
case's assertions. The tests use real scheduling and asynchronous yielding.

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

**Use Restart Manager to identify a directory holder.** Its
[`RmGetList` contract](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist)
rejects registered directories. Native handle enumeration can observe the
directory itself while keeping query failures and partial access explicit.

**Keep the original eleven-second cleanup and 1.5-second observation.** Those
waits originally crossed the ordinary ten-second hook limit and exposed late
global restoration. The same ordering follows from a registration-local default
and shorter synthetic waits, without adding 12.5 seconds to every file run.

**Shorten only the waits or change the default during execution.** Short waits
under the ordinary ten-second fallback cannot expose a missing explicit budget.
Changing the default in a runtime hook is too late because the timeout wrapper
already captured it at registration.

## Consequences

The hook waits for bounded owned cleanup before restoring globals. The adjacent
regression cases retain the parent/child ticket-path, mock and completed-cleanup
assertions while crossing a short captured fallback. Their timing no longer
requires the former ten-second limit to elapse. Only synthetic waits change;
real process observations and production deadlines retain their original bounds.

The hook budget is distinct from the production stop deadline. Joined probes can
finish after a polling deadline, so that deadline is not a strict wall-clock
limit. Missing ownership still prevents deletion. Failure evidence can explain
an unavailable original Controller without manufacturing a successful startup
or attributing every system timeout to a product defect.
