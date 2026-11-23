# Agent Note: Retired Web Process Completion

Status: implemented

## Problem

Retired Web cleanup tests inspected saved controller and provider proofs but
required the result to be exactly `stopped`. A numeric PID can identify a new
process after the original exits. The observer reports that case as `replaced`,
so the assertion could reject successful cleanup. A replacement observation
alone is insufficient: on POSIX, the same result can indicate conflicting
command or group evidence for the original birth.

## Decision

The retired Web native tests use the process observer's mismatch callback and
retain the complete observation in assertion diagnostics. An original instance
is considered stopped only for `stopped`, or for `replaced` with explicit
`sameBirth: false`. Running, exiting, missing mismatch evidence and same-birth
conflicts fail; native observation errors propagate.

The local assertion is shared by the fixture cleanup, recovered provider and
retired generation checks. Deterministic cases control only the observer's
result and mismatch evidence. The integration cases retain real shutdown and
patrol, process-close witnesses, empty Windows Jobs, stopped journals, removed
worktrees and unaffected successor processes and files.

## Alternatives

**Accept every result except running.** This would accept exiting originals and
same-birth identity conflicts without evidence that the original ended.

**Require the PID to disappear.** A new process can keep the number occupied;
waiting longer does not establish anything about the original birth.

## Consequences

The assertions distinguish original-instance completion from numeric PID
availability without changing production process management or deadlines.
Controlled observations verify the acceptance rule, including same-birth
command and group conflicts; they do not claim to force native PID recycling.
The [Windows exit completion decision](../bug-fix/2026-11-13-windows-controller-exit-completion.md)
owns native completion semantics, and the
[stale birth fixture decision](2026-11-18-controller-stale-birth-fixture.md)
explains real-process birth-fence coverage.
