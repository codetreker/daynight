# Agent Note: Recover Original Windows Sessions Across a Prepared Reboot

Status: implemented

## Problem

Worker interruption loses its authenticated Windows Job leases. A Controller
can also have exited without a durable complete-stop record, leaving original
claims and capacity retained indefinitely. Known PIDs being absent does not
prove that an unrecorded descendant stopped. Closing the last Job handle removes
its name even when a member remains alive, so reopening a missing name cannot
recover the lost proof. Retrying without a complete boundary risks two writers
of one native Session.

## Decision

An explicit `worker reboot-recovery` operation prepares the exact original
execution before a user-controlled Windows restart and confirms it afterwards.
It preserves the active claim, worktree, platform Session, native identity and
initial-input receipts. It neither restarts the OS nor launches an Agent.

The private checkpoint binds ticket and snapshot hashes to the Windows
installation's hashed MachineGuid and the kernel BootIdentifier. Preparation
holds the original storage permit, requires confirmed initial input, and leaves
the journal unchanged. A conflicting checkpoint is never overwritten.
Confirmation requires the same installation, a different boot GUID and the
unchanged original execution. An existing shutdown intent is preserved and
allowed to acquire stop proof; rejecting it would make normal Worker shutdown
and missing-proof recovery block each other. Terminal cleanup remains refused.
The operation does not derive boot boundaries from clocks. Unknown native
observations fail closed.

A process-local opaque proof binds those observations to the original hashes.
The stop writer validates it again and uses the existing snapshot, ticket and
owner CAS. The existing version-1 `windowsJobStopProof` remains a complete-stop
result usable by normal recovery, independent of whether the stop boundary was
an authenticated empty Job or a verified intervening boot. Existing readers and
the normal generation, pause, recovery-budget and input rules remain unchanged.

The [Session protocol](../../../../docs/design/task-session-protocol.md#windows-跨重启停止证明)
owns the checkpoint format, command and trust boundaries. This extends the
historical recovery gap named by the
[original exit-completion decision](2026-11-13-windows-controller-exit-completion.md)
without relaxing that decision's same-boot handle requirements.

## Alternatives

**Treat missing PIDs or a missing Job name as stop.** A real Job fixture retains
an unrecorded live descendant after the last named handle closes. These
observations cannot establish the full tree boundary.

**Compare process timestamps with LastBootUpTime.** Wall-clock correction can
change ordering without a restart. A pre-reboot kernel identifier comparison
avoids manufacturing a stop boundary from wall-clock arithmetic.

**Require boot identity in every original spawn record.** That can support
future executions but cannot establish it retrospectively for already-retained
records. A preparation checkpoint covers the original local execution before a
subsequent real restart.

**Force-withdraw and re-claim.** That changes execution ownership and may abandon
the native conversation. It also does not prove that the local old process tree
stopped. The chosen operation retains the original execution contract.

## Consequences

Historical executions can acquire a complete-stop record without recovering a
lost kernel handle. The cost is an explicit preparation phase, a full Windows
restart and confirmation; restarting only the Worker is deliberately
insufficient. Preparation is not recovery completion. Normal Worker recovery
can still refuse on a different existing failure or exhausted budget.

MachineGuid binds an installation, not authenticated hardware. The mechanism
shares the journal's trusted-local-writer assumption and does not defend
against malicious state edits, cloned installations or system snapshot
rollback. Native API incompatibility and inaccessible registry identity preserve
the retained resources rather than falling back to timestamps.

Controlled boot observations test the real SQLite stop CAS, unchanged
operations/outbox and next-generation continuity. Real same-boot native reads
and the existing real Job-descendant regression cover their respective OS
mechanisms; neither substitutes for an actual user-controlled reboot and
Provider reconnection acceptance.
