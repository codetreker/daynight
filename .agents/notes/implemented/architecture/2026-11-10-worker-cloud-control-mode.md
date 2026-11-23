# Agent Note: Worker Cloud Control Mode

Status: implemented

## Problem

My Workers can edit native settings and observe their application, but a locally
owned execution mode prevents the same interface from choosing Herdr or Web.
Importing a default mode into an existing cloud target can also change an
established Web Worker without the operator choosing that change. A successful
native validation under one mode does not prove that the same arguments are
valid under the other mode.

## Decision

The original Worker configuration resource negotiated a global
`agentControlMode` wire and nullable adoption state. `Daynight-Worker-Control-Mode: 1`
was independent of configuration protocol versions 1 and 2. Old full PUTs
preserved the current mode inside the row lock and target CAS; a bootstrap
candidate filled an unadopted mode without replacing another cloud setting.

The mode item and its original index occupied a private `controlModeObservation`
slot in JSONB, keeping older struct decoders from exposing an unknown item. An
older service replacing an observation discarded that extension, so its absence
could not revive stale evidence. The [two-tool protocol decision](2026-11-17-worker-two-tool-protocol.md)
replaces the public mode configuration and adoption; the service retains the
historical slot decoder to preserve stored observations and archive positions.

The [tool-path configuration decision](2026-11-11-worker-tool-path-configuration.md)
originally extended independent negotiation and locked adoption to each tool,
and added selection-aware inputs to native qualification alongside mode evidence.

The original grouped mode and native application prevented a new mode from
being published with arguments validated for another mode. It validated mode and
global native together, persisted the pair before publishing, and retained the
previous effective pair on failure. Project proof bound mode and native, so mode
changes revoked old qualification without discarding repository preparation or
unfinished removal obligations.

When a target mode failed, the earlier implementation revalidated the previous
global pair in the current process, then allowed compatible historical Project
tuples to be revalidated under that restored mode. This avoided making otherwise
usable Projects wait indefinitely for a failed target. Such recovery retained
the target failure and did not declare the failed target applied. A cached
success or a mismatched historical mode did not grant qualification.

An unacknowledged removal could retain a Project observation after a mode change
revoked its proof. The serialized owner therefore calculated new proofs, changed
reselected applied items without matching evidence to pending, and persisted the
cache before publishing proof. This prevented a report from claiming success
before revalidation. Existing claims kept frozen mode, native, session and
worktree through recovery and cleanup. Frozen claim configuration took precedence
over new Project qualification, subject to removal and permission gates. A
backend serving a live claim remained available across a default change.

The current Web-only configuration decision replaces that application model;
the original reasons remain relevant to understanding mode-bearing checkpoints.
This decision partially supersedes the local mode ownership in the archived
[cloud application decision](../../archived/architecture/2026-11-04-worker-cloud-runtime-configuration.md).
Keeping mode local originally avoided changing its strict wire representation
and launch-validation boundary. Cloud ownership originally required explicit rollout
negotiation, adoption and grouped validation; the earlier rationale remains
useful for understanding those costs. The [configuration contract](../../../../docs/spec/daynight-worker-configuration.md)
and [Worker design](../../../../docs/design/daynight-worker.md#配置与目录)
own the current protocol and application mechanisms.

## Alternatives

**Add only a Web select.** The server and CLI would still omit the field, so a
successful form save could not change or confirm the Worker mode.

**Default every missing stored mode to Herdr.** Existing Web Workers would be
silently changed during upgrade. A separate nullable adoption state preserves
their actual local setting and allows explicit cloud choices to win races.

**Add the field unconditionally to configuration protocol 1 or 2.** Strict old
clients would reject the additional field, and old full replacements could erase
it. Independent capability negotiation protects both prompt-protocol versions
without making mode support depend on prompt support.

**Protect rollback only in the new HTTP projection.** A rolled-back binary does
not execute that projection. Persisting a new key directly in the old item array
would let it return an unknown kind to strict clients. A private stored extension
keeps the legacy reader valid without relaxing public parsing.

**Only reschedule applied items when their process proof is missing.** This
restores execution eventually but lets a report and the Web form claim the new
target is applied before revalidation. Normalizing the state in the same commit
prevents that observable false success while preserving historical values.

**Apply mode as an independent scalar.** A new mode could be published alongside
native arguments validated only for the old mode. Grouping mode and global native
validation prevents that combination; Project qualification must include the same
mode to prevent a similar admission gap.

## Consequences

The service rejects the retired capability and preserves existing stored
observations for historical decoding. New Workers do not report mode evidence.

The original rollout added a capability distinction, an unadopted target state
and a cache migration. Historical observations and frozen claim continuity remain
separate from the retired configuration behavior.
Service or component tests cannot establish actual Worker side effects; isolated
Worker execution and browser observations retain their separate evidence scope.
