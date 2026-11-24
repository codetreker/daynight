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

After the fixture has confirmed the original processes stopped and released
their empty Windows Job, cleanup observes the original provider again without
issuing another stop against its saved PID. A repeated stop can correctly reject
a reused PID before the completion assertion gets to distinguish its birth.
Fixtures that have not released a verified stopped Job still request a stop;
stop failures and subsequent observation failures remain test failures.

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

**Catch replacement errors from repeated stops.** The fixture already retains
verified Job release evidence. Using that evidence avoids an unnecessary stop
request and leaves production identity refusals intact, while the independent
completion observation still rejects same-birth conflicts.

## Consequences

The assertions distinguish original-instance completion from numeric PID
availability without changing production process management or deadlines.
Controlled observations verify the acceptance rule, including same-birth
command and group conflicts, released-Job cleanup and observation failures;
they do not claim to force native PID recycling.
The [Windows exit completion decision](../bug-fix/2026-11-13-windows-controller-exit-completion.md)
owns native completion semantics, and the
[stale birth fixture decision](2026-11-18-controller-stale-birth-fixture.md)
explains real-process birth-fence coverage.
