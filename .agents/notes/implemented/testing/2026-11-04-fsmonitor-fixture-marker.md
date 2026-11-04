# Agent Note: Prove fsmonitor suppression with a live marker

Status: implemented

## Problem

The fsmonitor regression must establish that ordinary Git can execute a configured
repository monitor and that a protected read-only query does not invoke it. Its
fixture writes an invocation marker and then idles for two seconds. The positive
control pays that delay before the protected query starts, although the marker
already records the required execution fact.

## Decision

The real executable monitor writes its marker and exits. Ordinary Git runs first
and must produce the marker, qualifying the configured executable on the actual
host. The test removes that marker, then runs the protected query under the same
500ms test-operation budget and verifies exact NUL-delimited output and an absent
marker. The hook path still contains whitespace, retaining the native quoting
case.

Removing the production command-scoped fsmonitor suppression must still fail the
original marker-absence assertion. The fixture therefore detects invocation even
when the incorrectly launched monitor returns promptly. Production Git options,
operation deadlines and the other native process-lifecycle tests are unchanged.
The existing Windows early return remains; this fixture's elapsed-time reduction
applies to the Linux and macOS paths that execute the hook.

The [archived review-worktree decision](../../archived/architecture/2026-10-17-owned-review-worktrees.md)
records the original rationale for excluding repository extensions from managed
Git commands. The [development guide](../../../../docs/development.md#cli-development)
owns current validation commands.

## Alternatives

**Keep or shorten the fixture's idle delay.** A delay repeats an elapsed-time
cost after invocation has already been observed. The existing marker-positive
and marker-negative checks establish the relevant distinction directly.

**Replace Git or the monitor with mocks.** That would remove the native evidence
that the repository configuration points to an executable monitor and that the
adapter's actual command suppresses it.

## Consequences

The positive control no longer idles after proving hook invocation. The test
retains real Git, filesystem state, executable startup, its operation budget and
all existing assertions. A missing suppression option is reported through the
marker rather than depending on a deliberately stalled fixture.

This change does not accelerate the Windows branch or replace native termination
and stream-closure proofs. Hosted platform results remain distinct from local
case measurements and whole-suite wall time.
