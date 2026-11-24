# Agent Note: Stable Linux Process Birth Identity

Status: implemented

## Problem

Linux `ps lstart` can change for a running process while its kernel starttime
ticks, command and launch marker remain unchanged. Comparing the displayed
wall-clock value with the saved proof then rejects an original Controller,
preventing normal Bot shutdown and recovery. The refusal protects against
signaling an unproven process, but the birth representation makes legitimate
ownership impossible to re-establish.

The [locale decision](../../archived/bug-fix/2026-10-28-controller-process-locale.md)
made POSIX output comparable across localized shells. Its rationale remains
valid for parsing, especially on macOS; a fixed locale does not make a Linux
wall-clock rendering stable. The observed drift does not establish whether
NTP, suspend, manual adjustment or another mechanism changed the clock.

## Decision

The adopted [Session requirements](../../../../docs/spec/task-sessions.md#linux-进程出生身份)
require Linux boot identity and kernel starttime ticks for the process proof.
The [Session design](../../../../docs/design/task-session-protocol.md#linux-稳定出生身份确定方案)
defines the versioned token, consistent sampling and persistence obligations.
Controller capture, persistent readers and the extraction child originally shared
this format. The later [Controller launch identity decision](2026-11-24-linux-controller-launch-identity.md)
uses a separate launch record for new Linux Controllers; legacy Controller and
native Provider proofs retain this birth identity and its original checks.

Birth identity remains separate from command, process group and execution
ownership. Historical Linux proofs remain readable, but no current PID lookup
may upgrade them into permission to signal. The records and unknown process
responsibility survive refusal. macOS and Windows retain their platform paths.

The sampler distinguishes a running proof, an exiting observation and a terminal observation. Boot,
ticks and process group must agree throughout sampling. A final kernel zombie
state can prove that instance exited even if its parent, command display or
zombie state changed during the observation. Capture callers reject this result
as a running proof; inspection can establish only the saved birth and group's
single PID as stopped. Descendants and live group members require separate
confirmation. Requiring all running fields to remain unchanged originally
prevented mixed-instance proofs, but also rejected genuine exit transitions;
the terminal branch preserves the birth and group fence without requiring
fields the exiting process no longer maintains.

Before zombie state, a final kernel `PF_EXITING` flag permits only passive
waiting when the sampled birth and group also match the saved proof. Capture
callers reject this observation as a running proof. Inspection waits at most
25 milliseconds between complete samples, sharing one fixed `performance.now()`
deadline across waits and reads. The flag itself proves neither stopped nor
permission to signal: only a later matching zombie or authoritative ESRCH
confirms the single PID stopped. Unconfirmed expiry retains responsibility.
The wait can outlive an earlier group inventory. If no original instance remains
to authorize a signal, Linux reads the group again within the same deadline.
Only when every inspected original group instance is explicitly stopped may it
wait for descendants to finish naturally. The wait sends no signal, creates no
new grace period and retains unconfirmed survivors at expiry; replacements and
identity conflicts cannot enter it. An empty group still requires the caller's
final original-instance and group confirmation.
The kernel sets this flag before address-space teardown, as documented in the
[Session design](../../../../docs/design/task-session-protocol.md#linux-稳定出生身份确定方案);
ordinary command conflicts do not receive this waiting exception.

## Alternatives

**Continue comparing `lstart` under `LC_ALL=C`.** This prevents localized date
parsing failures but cannot prevent the observed time display from changing.

**Ignore birth mismatches when command or launch marker matches.** These values
do not prove that the same process instance still occupies a PID. Removing the
birth check would weaken the protection that correctly rejected an uncertain
stop.

**Store only starttime ticks.** Ticks identify elapsed time within one boot;
including boot identity prevents a later boot from satisfying an earlier
process proof with coincidentally equal PID and ticks.

**Rebuild historical proofs from the live PID.** A newly observed process may
already be a replacement. Rewriting the original record would manufacture the
missing relationship instead of proving it.

**Retry every inconsistent sample within a bounded deadline.** Ordinary command
or identity conflicts have no evidence that waiting will establish an original
process's exit, so they remain refusals. A kernel `PF_EXITING` observation of
the saved birth and group instead establishes an exit transition and permits
bounded resampling to observe its completion. Once the final kernel state proves
the same instance is a zombie, another sample adds no necessary evidence.
Both exit paths preserve one observation budget; neither retries an arbitrary
identity mismatch or treats an exit flag as completion.

## Consequences

The accepted contract removes dependence on wall-clock rendering for new Linux
proofs while retaining independent process and execution checks. Consistent
sampling adds bounded reads. Exits cannot supply a running proof, and replacement
still invalidates the entire observation. A verified zombie permits only the
original single-instance stop conclusion, never a complete process-tree stop or
permission to signal. A pre-zombie exit may consume the original observation
budget while remaining unconfirmed; expiry cannot become a stopped result.
Every persistent reader and the extraction child must preserve
the token; accepting an unknown version as a historical date would defeat the
format boundary.

Historical executions with incomplete proof can remain blocked. This decision
does not reconstruct their missing identity or authorize deleting their records.
Controlled tests must distinguish stable birth from PID reuse and boot changes;
real Linux Worker/Bot and Controller lifecycle evidence is still required before
claiming the defect fixed. Platform regressions do not establish untested
wall-clock scenarios on macOS or Windows.
