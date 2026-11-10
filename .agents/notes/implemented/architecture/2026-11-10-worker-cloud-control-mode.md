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

The Worker configuration resource owns the global `agentControlMode` after
explicit capability negotiation and first adoption. New local configurations
default to `herdr`; an existing local `web` configuration remains `web` when its
cloud target first adopts a mode. A nullable target means that adoption has not
occurred. It is not a third mode or evidence of an applied default.

`Daynight-Worker-Control-Mode: 1` is independent of configuration protocol versions
1 and 2. A response must echo the capability before a client exchanges the new
fields. Old responses omit the mode and its observation item. An old full PUT
preserves the current mode inside the existing row lock and target CAS. A
separate bootstrap candidate can fill an unadopted mode without replacing any
other cloud setting. A previously saved non-null choice wins over late candidates.

Persisted observation items remain readable by the pre-capability service. The
mode item and its original index occupy a private `controlModeObservation` slot
in the existing JSONB; new readers reconstruct the public item list, while old
struct decoders ignore the extension. One protocol codec owns both persistence
and the stored-byte budget. An old service replacing the observation discards
that extension; after upgrade its absence means no current mode evidence, not
permission to revive a stale applied result.

Mode and global native settings form one application unit. Validation receives
the target mode explicitly, including local model and effort normalization. The
existing serialized cache owner persists the successful pair before publishing
it. Failure retains the prior effective pair. Project native validation records
bind the mode and tuple together; a mode change invalidates their old qualification
without discarding repository preparation or unfinished removal obligations.

Restarts rebuild native validation proofs. If the current global mode target
fails and the previous global pair is validated in this process, historical
Project tuples can be revalidated under that restored mode. Waiting for the
failed target mode would make otherwise usable Projects unavailable indefinitely.
The existing application owner retains the target failure and retry policy;
historical recovery grants only a current-process proof for the matching mode,
never an applied result for the failed target or authority from cached success.

Unacknowledged removals can retain an applied Project observation after a mode
change revokes its process proof. Reselecting the same tuple and historical mode
does not restore that proof. The serialized owner calculates the next proofs and
normalizes selected applied items without matching evidence to pending before
persistence. It publishes the cache and proofs together only after a successful
write; unselected history remains owned by removal acknowledgement.

New claims consume the applied mode. Existing claims retain their frozen mode,
native configuration, session and worktree through advancement, retry, recovery
and cleanup. Their frozen configuration is consulted before new-mode Project
native qualification, while Project removal and permission gates still apply.
Before a Web execution record exists, the main store already owns the tuple
frozen when the claim was registered. That snapshot remains authoritative during
configuration changes between the claim response and first execution.
Backend availability follows actual claim ownership: switching defaults does not
stop a backend with live claims, and Herdr can start lazily when newly required.

This decision partially supersedes the local mode ownership in the archived
[cloud application decision](../../archived/architecture/2026-11-04-worker-cloud-runtime-configuration.md).
Keeping mode local originally avoided changing its strict wire representation
and launch-validation boundary. Cloud ownership now requires explicit rollout
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

Operators can edit and confirm a Worker's mode without rewriting its YAML or
restarting existing claims. Older services retain local behavior, and older
Workers do not acquire a false applied result merely because the cloud target
contains a mode. Unknown actual values, failures and pending application remain
visible in the existing form feedback.

The rollout adds a capability distinction, an unadopted target state and a cache
migration. Tests must preserve old strict envelopes, concurrent adoption, failure
retention, mode-specific native qualification and frozen claim continuity.
Service or component tests cannot establish actual Worker side effects; isolated
Worker execution and browser observations retain their separate evidence scope.
