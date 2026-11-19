# Agent Note: Controller Independent Cleanup Waits

Status: implemented

## Problem

The [independent Controller tests](../../../../packages/daynight/test/commands/controller/independent.test.ts)
retain real process witnesses for two cleanup paths. The original Windows child
has no available IPC endpoint, so the test repeatedly waits for the observation
window to expire. The POSIX fixture acknowledges the stop request and stays alive
for bootstrap cleanup, which consumes the full grace before signaling it.
Both waits dominate the selected scenarios after the evidence that triggers
the cleanup path is already observable.

## Decision

For the Windows handle case, let the first native IPC observation fail before
advancing the test clock across the observation window. The production logic
still has its reserved termination budget. The test observes the exact SIGTERM
call on the original child handle and its actual exit, with no established Job
lease or completed cleanup record.

For the authenticated POSIX snapshot case, preserve a real timer while
shortening the requested 2,500 ms exit grace to 25 ms in that test. Assert
that the production path requested the original grace. The Controller still
answers authenticated IPC, the journal encounters a real SQLite I/O failure,
and cleanup must stop and confirm the native process group.

## Alternatives

**Wait through both production intervals.** That repeats real observation
delays for a child whose unavailable endpoint is already established and a
POSIX fixture which deliberately stays alive after its acknowledgement.

**Replace native exit or group termination with simulated results.** That
would leave the Windows handle and POSIX process-group mechanisms unexercised
in the two cases that own their real witnesses.

## Consequences

The tests continue to depend on actual platform cleanup behavior while
avoiding elapsed time that does not change those outcomes. The logical
Windows observation budget is also covered by the separate cutoff test.
Windows handle validation runs on Windows because a Linux process cannot
verify native handle behavior.
