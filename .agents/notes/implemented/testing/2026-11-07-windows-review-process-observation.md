# Agent Note: Observe Windows review fixture termination

Status: implemented

## Problem

The review supervisor test compares a leaf process's heartbeat twice after
`stop` returns and the directly launched wrapper closes. A changed value proves
the observed file was not stable. It cannot distinguish an executing descendant
from an unfinished file operation, because the wrapper does not retain the
leaf's standard streams. A successful `taskkill /T /F` result alone supplies no
documented observation of each fixture process's exit.

## Decision

The two Windows native-tree cases retain their original fifteen-millisecond
heartbeat, stop/close ordering, eighty-millisecond comparison and exclusion
assertions. A test-only observer opens process handles before termination for
the fixed wrapper, parent and leaf. The parent and leaf publish their own native
creation times; the observer compares those identities before accepting their
handles. Root termination continues to use the original Node child handle.

Immediately after `stop` resolves, the observer synchronously queries each held
handle with a zero-timeout wait. It also samples during stopping and records
root-close and both file-read boundaries. Events retain monotonic observation
intervals, UTC timestamps, first signaled observations and native exit times.
Sampling is not instantaneous: recorded intervals and the maximum polling gap
bound the available evidence. A live handle at stop return remains a failure
even if that process exits before the original heartbeat assertion completes.

Diagnostics are emitted from cleanup for both passing and failing cases. Cleanup
may terminate only the parent and leaf identities already held by the observer
and the original Node child. It runs before any cleanup wait for Node closure:
an exited wrapper can leave its inherited output streams open in a surviving
parent, and awaiting that close would prevent the observer from terminating the
parent. The observer bounds its own process-signal and root-close confirmation,
releases held handles even on failure, and preserves the primary test failure
when cleanup also fails. Failure to acquire identities, observe exits or release
handles remains visible. Production termination behavior is unchanged.

## Alternatives

**Write the heartbeat atomically or ignore empty reads.** Either can hide a
post-stop write that is interrupted between truncation and completion. Neither
establishes that the writer stopped before exclusion.

**Wait for a stable value or add a delay.** This moves observation later and can
erase evidence that the stop operation returned early.

**Query descendant PIDs after stopping.** A PID can refer to a different process
after reuse, and a one-time inventory can miss later descendants. Held handles
and creation identities avoid that ambiguity for this fixed fixture.

**Contain the fixture in a new Job Object.** That changes the termination scope
under investigation. Native containment may be a production remedy if evidence
supports it, but is not part of this observation strategy.

## Consequences

The test can distinguish an observed live fixture member at stop return from a
changed file observed after all held members signaled. Passing observations do
not establish the cause of an earlier failure. The fixed three-process inventory
does not prove ownership or termination of arbitrary late descendants, and
macOS checks cannot substitute for real Windows execution.

The separate [native test termination diagnostics](2026-11-05-native-test-termination-diagnostics.md)
decision owns the macOS Vitest observer. This decision adds evidence for the
Windows review fixture without changing that owner or the supervisor's public
contract.
