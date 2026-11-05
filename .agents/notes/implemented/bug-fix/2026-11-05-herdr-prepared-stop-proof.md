# Agent Note: Stop Proof for Unlaunched Herdr Preparations

Status: implemented

## Problem

A macOS Herdr preparation registers a daemon, shell, generation and recording
responsibility before starting the native provider. The original stop contract
requires a shell and an agent. A preparation that never reaches native launch
cannot supply the latter, even when its original resources have stopped. It
therefore retains an execution slot and cannot finalize its recording. After the
closing phase overwrites `prepared`, absence alone cannot recover the lost fact
that no native launch was submitted. A crash after `close_requested` can also
leave the original resources stopped without a committed proof. Restarting the
stop sequence by reverting to `stop_intent` violates the monotonic lifecycle and
prevents that original responsibility from ever converging.

## Decision

The lifecycle journal retains a monotonic `nativeLaunch` fact separately from
its closing phase. A new preparation records `not_submitted`; the launch intent
changes it to `requested` before calling the native manager, and original agent
capture changes it to `observed`. Unknown historical closing records remain
`unknown`. Journal format migration validates original records and preserves
pending messages, hashes and stopped native proofs.

A distinct v2 preparation stop proof requires explicit `not_submitted`, the
original daemon, exactly one original shell, and confirmed stopping of that
resource scope. It cannot contain an agent or a capture segment. Ordinary proofs
retain their exact JSON shape and mandatory shell and agent identities. Neither
proof allows uncertain input to be replayed, and preparation proofs cannot grant
another native generation or automation recovery.

A recovered `close_requested` run preserves its committed stop operation and
reason without incrementing the control epoch again during stopping. The normal
recovery fence still advances when the lifecycle is reopened. It repeats the original process verification and exclusive
stop before committing a proof; it does not rewind the lifecycle or infer
stopping from the phase. Changed or unreadable original identities still retain
`stop_unknown`. This applies to preparation and native runs alike.

The service checks preparation proofs against recording content in both write
orders and before finalization. A later nonzero recording report cannot turn an
accepted preparation proof into a contradictory frozen ledger. Capture failures
remain failures. Error-free empty preparations use the existing unavailable
receipt; a final empty generation does not discard earlier recorded frames.

This extends the [v2 contract decision](../architecture/2026-11-03-session-v2-terminal-contract.md)
and partially replaces the [lifecycle decision](../architecture/2026-11-04-herdr-worker-lifecycle.md)
only for provably unlaunched preparations. The [contract design](../../../../docs/design/session-v2-contract.md)
owns the wire fields; the [lifecycle design](../../../../docs/design/herdr-worker-lifecycle.md)
owns process evidence, migration and stop ordering.

## Alternatives

**Mark the local preparation stopped without changing the contract.** Registered
runs still require server-accepted proofs before finalization; dropping local
responsibility would abandon that obligation.

**Allow an ordinary proof without an agent.** This could misclassify a submitted
launch whose agent identity was lost. The explicit branch and monotonic launch
fact preserve that distinction without fabricating an agent identity.

**Register a run only after native launch.** This changes registration, crash
recovery and recording ownership, and cannot settle preparations already
registered under the existing sequence.

**Permit `close_requested` to revert to `stop_intent`.** The close request already
records the stop authority. Rewinding that boundary would hide repeated intent
creation and control-epoch changes instead of making the existing operation
recoverable. Preserving the phase still requires the full original process
check; it is not permission to skip stopping.

## Consequences

Known unlaunched preparations can finish through the original stop, ledger and
archive pipeline. Native launch uncertainty and incomplete original process
evidence remain conservative retention states. The intent is deliberately
recorded before manager preflight, so a later prerequisite failure cannot erase
the possibility of dispatch. Older closing records without agent evidence are
not retroactively classified as unlaunched.

The v2 extension requires updated service and Web readers before Workers emit
the new proof. Old ordinary proofs and v1 are unchanged. Old strict readers
reject the added branch; failures retain evidence and cleanup responsibility,
and cached older pages need a refresh. Fixed archives are never rewritten for
compatibility. Protocol acceptance verifies structure and ownership, not the
actual macOS process state observed by the Worker.
