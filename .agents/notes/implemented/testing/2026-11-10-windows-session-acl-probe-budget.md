# Agent Note: Windows Session ACL Probe Budget

Status: implemented

## Problem

The Session operation-store test independently reads a real Windows file DACL,
adds an Everyone read ACE, and verifies that the store refuses the altered ACL.
Its external-command deadline must allow that verification to finish while
bounding a stalled command.

Windows [run 42817716869](https://github.com/codetreker/daynight/actions/runs/42817716869/job/129837030633)
failed the case at
[commit 0ec27cf4](https://github.com/codetreker/daynight/blob/0ec27cf400a9c75e0c02dc84febd124fb4cf42c9/packages/daynight/test/commands/task/session/operation-store.test.ts#L71-L105).
The `private-acl-readback` PowerShell child reached its 10,000 ms process deadline
and closed with `code: null` and `signal: "SIGKILL"`; the case lasted 10,049 ms.
The other 9,943 tests passed. Empty child output and the absence of a completion
record do not distinguish process initialization, scheduling, and ACL work.

## Decision

The test-owned `aclProcessMs` in
[`operation-store.test.ts`](../../../../packages/daynight/test/commands/task/session/operation-store.test.ts)
is 30,000 ms. The original decision applied that allowance to both PowerShell
readback and the subsequent icacls public-ACE grant, with a 65,000 ms case guard.
The [native ACL observer decision](2026-11-19-native-windows-acl-observer.md)
replaces the PowerShell readback after another timeout before script entry.
The remaining icacls command retains the complete-command allowance, including
startup and its body; the case guard is `aclProcessMs + 5_000`.

Independent native readback requires the current-user owner and a present,
protected DACL containing exactly one current-user FullControl allow ACE with
zero inheritance flags. The test then adds the real Everyone read ACE and
requires the operation store to reject it. Native command timeouts use SIGKILL,
await actual child closure, and preserve the original error as the cause. Stage
diagnostics, fixture cleanup, production ACL behavior, and unrelated test budgets
retain their existing ownership. The later
[oracle phase evidence decision](2026-11-18-windows-oracle-phase-evidence.md)
adds command lifecycle and script checkpoints after another empty-output
timeout at the retained 30-second bound; it does not establish a cause for
either historical stall.

The historical
[30-second initialization watchdog](https://github.com/codetreker/daynight/blob/30ef332cdce36e33850b9f1766f12ba675bb88b2/packages/daynight-web/scripts/acceptance/runner.test.mts#L70)
establishes a bounded native-initialization allowance in an earlier test harness.
That harness separated initialization and callback deadlines; this test retains
one process deadline covering both startup and command execution. The precedent
does not identify which phase consumed this failed run's time.

## Alternatives

**Keep the 10-second process deadline.** The observed Windows command already
exhausted it before the private ACL observation completed, preventing the public
ACE rejection check from running.

**Separate initialization and ACL execution with a readiness handshake.** This
could retain a shorter ACL-body deadline, but would add a child protocol and
distinct phase management without evidence locating the delay in either phase.
The bounded complete-command allowance preserves the existing native probe.

**Increase only the outer case timeout.** The child would still be killed at
10 seconds, so the observed failure would remain.

## Consequences

The original allowance increased a hung command's failure time by 20 seconds
and the two-command case guard by 40 seconds. The remaining icacls command keeps
that finite allowance, while private ACL readback no longer launches a shell.
Every real permission assertion and rejection remains inside the test. This
changes neither production deadlines nor permission policy.

The failure does not prove a slow ACL implementation or a process-startup cause.
Windows execution must still complete private readback, public ACE grant, and
unsafe ACL rejection; passing a platform-skipped invocation cannot establish
those native guarantees.
