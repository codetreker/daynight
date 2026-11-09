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
Revocation events discard old memory records immediately, including before a
failed lock can force memory-only operation. Disk reconciliation consumes the
event's existing token, so a valid sibling's first passive read is not revoked
again. Pending fences retain only validated generation and history-version
metadata. New observations capture that known metadata before queuing and still
require the locked version comparison; a superseded notification cannot renew
an older source against a later disk version.

The client publishes accepted-history and settled-history facts separately from
online pagination readiness. Applied-page coverage, rather than a current
snapshot or wall-clock timestamp, determines which cached rows have been verified.
An individual upsert verifies its own entry ID; it cannot extend a contiguous
page boundary across entries that no page has supplied.
The shared Session renderer accepts inert history data without a fabricated
snapshot. A null client permits the same shell and timeline to display history
before a verified binding exists. A real binding alone creates the actual client.
Verified rows own their entry IDs; uncovered preview rows remain explicitly
read-only and never enter the reducer, operation ledger or subsequent saves.

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
