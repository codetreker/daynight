# Agent Note: Retired Web Process Completion

Status: implemented

## Problem

Retired Web cleanup tests inspected saved controller and provider proofs but
required the result to be exactly `stopped`. A numeric PID can identify a new
process after the original exits. The observer reports that case as `replaced`,
so the assertion could reject successful cleanup. A replacement observation
alone is insufficient: on POSIX, the same result can indicate conflicting
command or group evidence for the original birth.

The birth-aware assertion addressed that observation rule, but provider fixture
cleanup still called `stopControllerBootstrap` before reaching the assertion.
That operation throws `ControllerBootstrapReplacedError` when a different birth
already occupies the saved PID. Cleanup could therefore reject a safely ended
original without performing its completion observation.

## Decision

The retired Web native tests use the process observer's mismatch callback and
retain the complete observation in assertion diagnostics. An original instance
is considered stopped only for `stopped`, or for `replaced` with explicit
`sameBirth: false`. Running, exiting, missing mismatch evidence and same-birth
conflicts fail; native observation errors propagate.

Provider fixture cleanup catches only `ControllerBootstrapReplacedError` from
the bootstrap stop operation, then runs the same bounded completion assertion
used after a successful stop. The exception alone does not complete cleanup.
Other stop errors retain their original identity and prevent confirmation;
confirmation failures and timeouts continue into the fixture's cleanup error
aggregation. The stop operation receives only the original proof, once, and no
retry targets a replacement process.

The local assertion is shared by the fixture cleanup, recovered provider and
retired generation checks. Deterministic cases control the observer's result and
mismatch evidence, or the fixture's stop and confirmation operations when
verifying error classification and propagation. The integration cases retain
real shutdown and patrol, process-close witnesses, empty Windows Jobs, stopped
journals, removed worktrees and unaffected successor processes and files.

## Alternatives

**Accept every result except running.** This would accept exiting originals and
same-birth identity conflicts without evidence that the original ended.

**Require the PID to disappear.** A new process can keep the number occupied;
waiting longer does not establish anything about the original birth.

**Treat the replacement exception as complete cleanup.** Skipping the subsequent
observation would remove the fixture's independent confirmation and its failure
diagnostics. The exception changes which stop outcomes reach that confirmation.

## Consequences

The assertions and fixture cleanup distinguish original-instance completion
from numeric PID availability without changing production process management
or deadlines. Controlled observations verify the acceptance rule, including
same-birth command and group conflicts. Controlled stop outcomes verify that
the precise replacement exception still requires confirmation, while unrelated
errors, same-name errors, aggregate errors and failed confirmation propagate.
These cases do not claim to force native PID recycling.

The [Windows exit completion decision](../bug-fix/2026-11-13-windows-controller-exit-completion.md)
owns native completion semantics, and the
[stale birth fixture decision](2026-11-18-controller-stale-birth-fixture.md)
explains real-process birth-fence coverage.
