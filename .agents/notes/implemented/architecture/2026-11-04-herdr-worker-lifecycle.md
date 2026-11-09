# Agent Note: Durable macOS Herdr Run Identity and Stop Recovery

Status: implemented

## Problem

A surviving terminal, an absent pane and a reused PID cannot establish whether
the original task execution is still running. After Worker interruption, losing
that distinction can replace an uncertain native conversation, replay assignment
input, or delete files still used by the original process. Session v2 also needs
stable ownership across connection changes and actual process restarts.

## Decision

The macOS Herdr backend owns a separate `herdr-executions.sqlite` journal. It
records the original claim, service, worker, worktree, Session, run generations,
process birth identities, connection epochs and collection segments. The
[lifecycle design](../../../../docs/design/herdr-worker-lifecycle.md) owns the
state transitions and consumer interfaces. Other platforms retain the legacy
Herdr adapter; Web retains its Controller and independent execution journal.

Each macOS run owns an unmodified Herdr daemon. Before assignment input, the
Worker persists daemon, shell and native process evidence and publishes the
generation ledger. Native conversation identity may arrive after input, but its
absence never authorizes a replacement conversation. Only a newly acquired claim
can create an empty launch record; existing claims without provenance fail closed.

Stopping commits an intent before changing process state. The native adapter
freezes the original instances with audit-token signals, checks the attributable
resource range, persists newly discovered descendants, and stops the exclusive
daemon before the shell and agent. This ordering prevents Herdr's automatic
terminal cleanup from re-resolving bare PIDs. Unknown resources cause refusal
and restoration of processes frozen by that attempt. Birth time and boot UUID
supplement the audit token because exec changes its pidversion without ending
the original birth instance.

Shutdown closes the run and its segments while retaining the claim and Session.
A confirmed stop, known native conversation and confirmed or explicitly resolved
initial input permit another generation; the [input arbitration decision](2026-11-04-herdr-input-arbitration.md)
keeps human-owned input suspended and preserves the original unknown receipt.
Reopening the Worker changes the connection epoch and starts a segment with an
explicit gap. A lost relay connection during an otherwise live run is recovered
by ordinary observation, even when native identity and recorded content remain
unchanged. The same claim and original native processes are verified before
reconnecting through the existing durable registration and readback path. That
connection advances only its connection epoch, preserving the Session, native
generation, segment and suspended input state. Task pause permits read-only
observation to reconnect but grants no automatic input or automation recovery;
the [pause input decision](../bug-fix/2026-11-09-herdr-pause-input-waiting.md)
retains separately authorized manual control. An unknown
registration is read back before any new registration; input is never replayed.
Browser lease revocation or expiry suspends input without invalidating a live
relay registration. Only actual channel closure clears the connected state;
ordinary observation cannot replace a live channel merely because its writer
lease ended.
An automatic known-menu or disabled-input rejection with no native write clears
only the current admission and preserves initial pending state when applicable.
The typed waiting result survives input-journal serialization, while any
possible write retains unknown-result protection. Daily automatic/cleanup
inspection supplies no empty-composer fact; explicit handback and clean recovery
retain the resume-only empty-field requirement described by the input design.

Stop proof, segment closure and ledger acknowledgement are separately recoverable
boundaries. Without a committed stop intent, emergency signaling cannot produce
a durable stopped result after restart.

The [preparation stop decision](../bug-fix/2026-11-05-herdr-prepared-stop-proof.md)
partially supersedes the requirement for native agent evidence when a monotonic
journal fact proves that the generation never submitted native launch. That
distinct proof covers the original daemon and shell; ordinary native proofs and
all uncertain-launch retention rules remain. A preparation proof grants no new
generation or automatic input permission.

This partially supersedes the [minimal claim record decision](../simplification/2026-10-27-worker-claim-records.md),
[Herdr adapter decision](2026-10-26-worker-herdr-adapter.md), and
[Web evidence separation decision](2026-10-28-web-execution-evidence.md).
Their shared index, native integration and Web ownership decisions remain.
The [resource-state cleanup decision](2026-11-04-worker-resource-state.md)
continues to own shared scheduling and legacy cleanup; macOS uses the original
instance journal for its stop and Session publication responsibility.

## Alternatives

**Query before and after `workspace.close`.** The existing API does not bind
close to a process birth identity. A replacement between observation and close
can still receive the destructive action. Shell exit also triggers internal
Herdr cleanup, so avoiding the explicit close RPC alone does not solve it.

**Add an atomic close API upstream.** This would require changing and distributing
Herdr. The client must work with the installed binary, so upstream changes are
outside this implementation's dependency boundary.

**Stop tasks inside a shared daemon.** Stopping that daemon would affect sibling
tasks. Leaving it running permits its automatic terminal cleanup to signal
processes by re-resolved PID. Exclusive daemons make that responsibility local
to one recorded run, at the cost of more daemon processes and state directories.

**Treat audit-token ESRCH as proof of exit.** Exec can invalidate the token while
the same birth instance remains alive. The adapter instead compares birth and
boot identity and retains unknown on changed execution images.

**Reconstruct missing provenance from remote summaries.** A NULL native session
or absent current pane cannot distinguish never-started execution from an
interrupted launch. Refusal preserves the original resources and conversation.

**Reconnect only when native identity or the ledger changes.** An idle terminal
can remain unchanged indefinitely after a relay disconnect, leaving its live
preview permanently offline. Connection ownership needs its own reconciliation
trigger; unrelated native events cannot provide that liveness guarantee.

## Consequences

Process control depends on macOS libproc, Mach audit-token observation and local
socket peer identity through Koffi. Permission or observation failures preserve
responsibility instead of authorizing replacement. Automatic Herdr update checks
are disabled for exclusive runs because their unregistered child processes would
make resource ownership uncertain.

The stop guarantee covers recorded original instances and descendants whose
continuous ownership can be established. It does not claim exhaustive discovery
of detached orphans or external copies of PTY descriptors. Unknown resources and
interrupted preparations can require operator resolution. The implementation
does not silently adopt legacy live runs without the required evidence.

The original lifecycle delivery retained worktrees and gated combined web
capabilities until recording and archive acceptance were available. The
[recording and finalization decision](2026-11-04-herdr-recording-finalization.md)
now enables those capabilities and releases execution capacity after durable
local stop confirmation. An independent archive queue publishes the stopped
ledger and retains resources until receipt acceptance or explicit operator
disposition. Segment metadata is not recorded output, and a local stop proof
is not a final archive receipt.
