# Agent Note: Persist Accepted Bot History Without Restoring Authority

Status: implemented

## Problem

A bounded pane cache cannot keep conversations visible across a document reload,
closed page or fourth-pane eviction. Current Session metadata can arrive before
history and says nothing about whether an empty local reducer is authoritative.
Restoring cached content must also survive account changes, deletion and delayed
storage work without recovering historical permissions or live activity.

## Decision

The authenticated identity scope shares the existing bounded display store through
a Bot coordinator. Only a real client's accepted, settled history supplies saved
entries and resource descriptors. Observers obtain a store lease before scheduling
their two-second coalesced candidate, recheck identity after asynchronous work and
never renew an old candidate after rejection. Account and cold-target cleanup
withdraw eligibility synchronously before best-effort physical clearing.

Passive storage invalidation reads do not touch the persistent LRU, preventing
two tabs from feeding each other's reads back into writes. An expired history
source cannot regain a lease through local draft publication; another accepted
history observation is required. Failed cleanup retries retain the original
disk value as their target and cannot revoke a newer same-account scope.
Their disk-only tombstone does not replace newer memory-only history or leases
in the shared storage realm. Account-wide revocation tokens also fence first
observations that have no cached preview yet; ordinary saves and LRU updates
trigger passive reads without revoking accepted history sources.
Every observed generation change discards the old lease before classifying its
source. New accepted history can obtain a fresh observation while the unchanged
old source remains frozen.
Revocation events discard old memory records immediately, including before a
failed lock can force memory-only operation. Disk reconciliation consumes the
event's existing token, so a valid sibling's first passive read is not revoked
again. Pending fences retain only validated generation and history-version
metadata. New observations capture that known metadata before queuing and still
require the locked version comparison; a superseded notification cannot renew
an older source against a later disk version.

A mismatch with a peer's persisted identity is negative evidence about the local
source, not authority to delete the peer's record or announce a history
replacement. Passive reads and preview-only first binding/history mismatches
idempotently freeze that source, even before a name or lease exists. Only new
accepted history progress permits another observation; draft publications and
repeated passive reads do not. The coordinator retains the barrier by client and
source across observer reconstruction. A reopened pane's new client still needs
an accepted history page before saving. Known local identity transitions retain
their cleanup and replacement behavior. The observer synchronously revokes its
store-owned observation, and saving checks that revocation inside the lock. This
also rejects an old save already queued past the coordinator's generation check
without invalidating another Bot's observation. Closing an observer stops normal
observation immediately but retains its negative subscription until all in-flight
saves finish, so pane eviction cannot remove a queued save's revocation guard.
Temporary deletion blocks use the same target source revocation and preserve
the last successful snapshot. Unblocking alone cannot renew an unchanged old
client's source; the reopened client must accept real history.

A confirmed definition with no Session withdraws the old pane, display seed,
retained Session state and persistent history. Its recoverable absence remains
in the identity scope across authentication pauses and selection changes.
Ordinary cached bindings and old history callbacks cannot release that barrier;
an explicit confirmed Session binding can. This separates initial unknown
details, which may display a preview, from authoritative absence without
permanently revoking a Bot that can later start a Session.

The client publishes accepted-history and settled-history facts separately from
online pagination readiness. Applied-page coverage, rather than a current
snapshot or wall-clock timestamp, determines which cached rows have been verified.
An individual upsert verifies its own entry ID; it cannot extend a contiguous
page boundary across entries that no page has supplied.
Each refreshed tail starts a new cursor chain's coverage rather than joining
disjoint tails through a minimum/maximum interval; older real rows remain by ID.
The shared Session renderer accepts inert history data without a fabricated
snapshot. A null client permits the same shell and timeline to display history
before a verified binding exists. A real binding alone creates the actual client.
Verified rows own their entry IDs; uncovered preview rows remain explicitly
read-only and never enter the reducer, operation ledger or subsequent saves.
The admitted display seed remains separate from the next persisted real tail.
Within the same identity and revocation generation, ordinary persistence updates
cannot replace it with a shorter record. Real coverage permanently consumes seed
rows, preventing them from reappearing after cursor-chain coverage resets. The
bounded seed only shrinks; it does not accumulate cross-tab history updates.

Preview resource access is explicitly disabled, including downloads. Historical
interactions cannot regain submission controls. New commands continue through
the independent [current-action admission](2026-11-09-bot-current-action-admission.md)
and the original live identity and capability checks. The
[Session design](../../../../docs/design/bot-session-view.md#持久显示快照与真实历史)
owns the interfaces and lifecycle rules.

## Alternatives

**Reconstruct a live snapshot from cached content.** Snapshot capability, activity
and interaction fields can be mistaken for current authority. An inert preview
type makes those fields unavailable and leaves operation recovery with its owner.

**Discard the preview when current metadata arrives.** Current does not establish
that history is loaded. It would replace readable content with an empty reducer
and cannot distinguish a valid empty page from an uninitialized shell.

**Keep every visited pane connected.** This avoids some evictions but does not
survive reload and increases connection and memory budgets. The existing three
panes and six bounded persistent targets remain independent.

**Enable previews before connecting cleanup.** A cold deleted target or a queued
write could recover private content. Cleanup is part of the same delivered data
flow, using the store's generations and leases rather than component state alone.

**Clear a mismatched peer preview or only return no preview.** Clearing grants an
unchanged stale client a new lease and can replace a peer's newer history with an
older epoch. Returning no preview alone leaves clients without an earlier lease
able to acquire the peer's current version. A negative source fence prevents both
paths while retaining the peer's data. Coordinator generations alone cannot stop
a save that has already passed their check and is waiting for the storage lock;
the captured store-owned lease must itself be revocable.

**Treat a null binding as both pending details and confirmed absence.** Pending
details may still admit a cached preview, while confirmed absence must withdraw
both preview and real old rows. A render-only flag also loses the negative fact
when authentication pauses or the selection changes. Keeping recoverable absence
in the scope and requiring explicit confirmation to restore it preserves both
outcomes; permanent Bot invalidation would prevent a later legitimate Session.

## Consequences

Reload and cold recovery reuse bounded recent history while the original owners
retain authorization, drafts, pagination and receipts. Matching rows share their
DOM identity and reading owner through preview handoff. No additional native
connection or complete offline history is created.

Web Locks and localStorage remain browser-dependent. Storage failures degrade
without breaking the live conversation; pagehide flushing is best effort, and a
failed physical clear cannot establish disk erasure. Controlled browser evidence
establishes frontend consumption and browser persistence, not native Provider or
physical-device behavior. The codec remains responsible for entry/resource
validation and the existing UTF-16 and count budgets.
