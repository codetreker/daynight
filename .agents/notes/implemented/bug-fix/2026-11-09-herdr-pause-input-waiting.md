# Agent Note: Preserve macOS Herdr input while paused

Status: implemented

## Problem

A paused task can retain an active macOS Herdr run while its owner handles a
problem in the terminal. The worker must neither exhaust its execution failure
budget during that ordinary wait nor prevent the owner from operating the
original session. A pause can arrive between input preparation and any native
frame, including after part of a prompt has already been written. Treating every
refusal as safely unsent would risk losing or replaying input, while treating
every refusal as a failure can permanently stop an otherwise healthy run.

## Decision

The [input arbitration design](../../../../docs/design/herdr-input-arbitration.md)
separates original claim and run authorization from purpose-specific task pause
policy. Automatic input and cleanup prompts remain subject to the pause gate;
manual control and input retain their existing owner, lease, epoch and target
checks without requiring the task to be unpaused. Explicit automation handback
requires the task to be unpaused and independently satisfies its draft and native
readiness checks. Resolving an unknown initial assignment remains separate from
handback and does not change its original receipt.

At a definitely unwritten boundary, task pause, legitimate manual or suspended
control, and known native input blockers carry explicit internal waiting reasons.
An admitted operation first records its rejected receipt; the lifecycle clears
its admission and retains pending initial input. Execution preserves the input
baseline and pending assignment, and the Coordinator does not charge waiting
against its failure budget. Actual authorization, service, storage and transport
errors remain failures. Once a write may have occurred, the original operation
remains unknown and suspended; unpausing does not replay it or restore control.

This partially replaces the periodic-only macOS application of the
[task pause decision](../feature/2026-11-02-task-paused-worker-pings.md), which
originally isolated continuation from initial input and cleanup. The
[input arbitration decision](../architecture/2026-11-04-herdr-input-arbitration.md)
retains its immutable receipts and manual ownership; the
[lifecycle decision](../architecture/2026-11-04-herdr-worker-lifecycle.md)
continues to own run identity and stopping.

## Alternatives

**Move only the continuation guard earlier.** The task can become paused during
native readiness, arbiter admission or between frames. An earlier check cannot
protect those boundaries or preserve the correct partial-write outcome.

**Ignore all unsubmitted or permission errors.** Those errors also represent
invalid ownership, failed reads and real faults. Broadly treating them as waits
would hide failures and might authorize an unsafe retry.

**Clear the failure budget on unpause.** That leaves ordinary pause classified
as a failure and discards real failures accumulated for the same claim. Explicit
waiting preserves the original budget and its meaning.

## Consequences

The same native observation can resume its eligible automatic input after pause
is removed, without replacing the claim or restarting the worker. Manual lease,
suspended state, unknown input and genuine failure budgets retain their own
recovery conditions. Per-frame authorization cannot retract a completed write;
partial input remains an explicit human recovery responsibility. Legacy Herdr
and the separate Web backend retain their own input and recovery policies.
