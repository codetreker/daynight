# Agent Note: Updater Fixture Command Expiry

Status: implemented

## Problem

Two updater integration scenarios prove timeout handling of a native command
tree and of Git invoked through compiled skill refresh. They already observe
real process readiness, then wait out a three-second command deadline before
checking termination. A
[macOS CI sample](https://github.com/codetreker/daynight/actions/runs/44243743660/job/134600298999)
reported 3.235 and 3.142 seconds for the two cases.

## Decision

The [timeout test drivers](../../../../packages/daynight/test/commands/update/updater.test.ts)
hold only the configured 3,000 ms command timer. The parent sends expiry after
real heartbeat and applicable POSIX process-group evidence. The driver requires
one active command deadline, invokes its callback once, and records receipt.
The command-supervision code still emits its timeout diagnostic, uses real
termination and process observations, and restores signal handlers. Native
cleanup delays and ownership evidence remain separate under the
[cleanup deadline decision](2026-11-17-update-cleanup-test-deadlines.md).

## Alternatives

**Use a short real command deadline.** A loaded runner could expire it before
the target process or Git leaf publishes readiness, removing the intended
termination proof.

**Replace native termination with a simulated success.** That would omit the
process-group, exit, and post-cleanup heartbeat evidence these scenarios own.

## Consequences

The timeout variants no longer consume the configured interval in wall time.
They retain real command execution and cleanup, and the signal-interruption
variants and production timing are unchanged.
