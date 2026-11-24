# Agent Note: Linux Controller Launch Identity

Status: implemented

## Problem

Linux Controller ownership must survive launcher restart and permit safe stop
and recovery without confusing a replacement process with the submitted one.
The existing birth-proof sampler can reject an observation when fields change
between samples. A recorded failure showed that this path could produce the
reported error, but did not establish whether the Controller or a native Provider
triggered it. A submitted launch may also fail before its bootstrap gate opens,
and a previously stopped generation's PID or process group can later be reused.
Neither a missing journal nor a current PID alone resolves those situations.

## Decision

New Linux Task, Bot and independent Test Controllers use the original ticket's
random `launchId` in the fixed bootstrap argv and save a distinct PID/launchId
record. PID locates procfs; the exact marker, detached group and ticket identify
the submitted Controller. Authenticated IPC still acknowledges startup and the
existing native process proofs still govern Providers. The [Session design](../../../../docs/design/task-session-protocol.md#linux-controller-启动身份)
owns sampling, stopping and cross-version behavior; the [requirements](../../../../docs/spec/task-sessions.md#linux-controller-启动身份与停止)
own the observable guarantees.

Only the original launcher, before invoking release and after confirming the
child exited, can settle an unreleased bootstrap. Task and Bot persist the result
beside the ticket, binding its hash and the child PID; independent Test uses its
existing never-started settlement. A conflict or uncertain release, exit or
write preserves responsibility. Settlement ends this local launch, not the
Session or an authorized later generation, and does not create a retry or ticket.
When a later unreleased generation leaves its predecessor's journal in place,
usage still uses the predecessor's validated ticket and retained grant. Archive
remains subject to the server fence. A confirmed recording discard persists an
ticket-, snapshot- and directory-bound intent before removal and a completion
receipt afterward, so recovery can continue its own partial deletion without
mistaking a replacement directory or unexplained absence for its result.

The supervisor records a ticket-bound complete stop only after independently
confirming the Controller, recorded native processes and original group stopped.
Later readers validate that receipt and original identities without requiring
the historical PID or group to remain vacant. Missing or conflicting evidence
retains the existing live-verification and refusal boundaries. Controller
self-report and an ordinary stopped snapshot cannot create this receipt.

This partially supersedes the [Linux birth identity decision](2026-11-19-linux-process-birth.md)
for new Controller records and extends the [submitted launch decision](2026-11-12-submitted-controller-launch.md).
Legacy Controllers, native Providers, Worker commands and other platforms keep
their existing proof semantics. Old launchers still produce old records after an
installation replacement; old binaries cannot consume new records.

## Alternatives

**Continue sampling the Controller's full birth proof.** Boot identity and kernel
ticks protect against PID reuse, but the additional parent, command and group
sampling can reject an observation when fields change. Retaining that path for
the new Controller would retain the failure path this decision removes; it
remains necessary for processes that lack this bootstrap identity.

**Use PID or a journal alone to identify the launch.** A PID can be reused and a
journal can contain a predecessor before the current writer commits. Neither
establishes the current authenticated Controller or permission to signal it.

**Recheck historical PID and group occupancy after complete stop.** Unrelated
processes can reuse those numbers after the original boundary was confirmed
stopped. A ticket-bound receipt preserves the earlier verified result without
mistaking later occupancy for a surviving original process.

## Consequences

Controller capture no longer depends on Linux birth sampling for new-format
launches, but Provider sampling remains unchanged and may still fail. The
launch marker can be copied or changed, and a race remains between observation
and signaling; this is not a defense against a malicious local process. Unknown
live identity and incomplete native stop continue to retain responsibility.
The durable unreleased result adds a separate conflict-checked record and does
not resolve a missing or uncertain result. Downgrade requires the new format to
be stopped and cleaned by a version that understands it; historical records
still scanned by old versions must remain under a compatible version or isolated
upgrade state. Candidate-bound Linux lifecycle and compatibility validation is
required to establish delivery; this decision alone does not establish that the
original failure originated in the Controller or that any platform test passed.
