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

The former input arbitration separated original claim and run authorization from
purpose-specific pause policy. Automatic input and cleanup prompts were subject
to the pause gate; manual control retained owner, lease, epoch and target checks
without requiring the task to be unpaused.
Automation handback required an unpaused task and independent draft and native
readiness checks. Resolving an unknown initial assignment did not change its
original receipt.

At a definitely unwritten boundary, pause, legitimate manual or suspended
control, and known native blockers were explicit waiting reasons. An admitted
operation recorded its rejected receipt before lifecycle admission was cleared;
the pending initial input and baseline were retained without charging the failure
budget. Authorization, service, storage and transport errors remained failures.
Once a write might have occurred, the original operation remained unknown and
suspended, without replay on unpause.

This partially replaced the periodic-only macOS application of the
[task pause decision](../../archived/feature/2026-11-02-task-paused-worker-pings.md).
The [input arbitration decision](../../archived/architecture/2026-11-04-herdr-input-arbitration.md)
recorded immutable receipts and manual ownership; the
[lifecycle decision](../../archived/architecture/2026-11-04-herdr-worker-lifecycle.md)
recorded run identity and stopping. The Herdr input execution path has since been
removed; the [Web-only runtime decision](../architecture/2026-11-17-worker-web-runtime-composition.md)
records the current boundary.

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

The original run could resume eligible automatic input after pause without
replacing its claim. Manual lease, suspended state, unknown input and genuine
failure budgets retained separate recovery conditions. Per-frame authorization
could not retract a completed write, so partial input remained a human recovery
responsibility. The separate Web backend retained its own input and recovery
policies.
