# Agent Note: Durable Image Drafts and Scoped Browser Preview

Status: implemented

## Problem

Image attachments must survive page reloads without crossing account or Session
boundaries. Upload completion does not prove native acceptance, and an old receipt
must not clear later editing. Per-card image fetching also loses shared state on
collapse and makes focus, cancellation and private Blob URLs difficult to retire
consistently across live and recorded Sessions.

## Decision

The repository publishes the adopted
[browser image design](../../../../docs/design/session-image-browser.md).
This note records a delivered design decision; the image runtime and its
acceptance remain unimplemented. IndexedDB owns immutable original Blobs,
content revisions, references and frozen operation intent. Short transactions
with CAS protect concurrent tabs. Web Locks coordinate network mutations, while
a durable single transition grants dispatch ownership. Unknown results retain
the original operation and block another send.

An explicit successor draft permits local editing without changing the frozen
submission. Native acceptance settles only the original draft identity and
revision. Scoped adapters provide verified leases to one preview host per real
Session or read-only record. Bounded page caches remain separate from durable
service references and browser draft storage. Preview lives inside the actual
Session presentation root, with explicit coordination for higher authentication
and deletion dialogs.

The existing [Bot cache decision](2026-11-04-bot-session-cache.md) retains ownership
of pane lifetime. The image design adds persistent Blob ownership outside that
cache; evicting a pane does not authorize deleting a draft. It does not change
current text behavior or claim that image support has shipped.

## Alternatives

**Keep attachments in memory or encode them in sessionStorage.** Reloads and
independent text/image writes can lose bytes or submission identity, and Base64
increases storage pressure. Atomic Blob and reference storage makes failures
observable before dispatch.

**Edit the frozen submission in place.** This changes operation intent or requires
ambiguous three-way reconciliation. A separate explicit successor preserves both
submitted content and later editing without introducing an automatic queue.

**Use last-writer-wins edits or a localStorage heartbeat lock.** Concurrent tabs can
lose text or dispatch duplicate input. CAS exposes conflicts; Web Locks never
steal a suspended tab's ownership, and persistent dispatch facts survive closure.

**Use an independent Blob and new browser tab for each card.** Collapse causes
repeat reads, while revocation, Escape and focus lose a common owner. Shared
scope leases preserve stable rendering and centralize cleanup.

**Portal one preview to document.body.** Existing fullscreen inert regions and
Task focus boundaries can exclude it. Root-local dialog hosting preserves those
boundaries; higher dialogs require a synchronous suspension bridge.

**Persist all viewed images or add cross-device drafts.** Both expand private
retention, synchronization and cleanup responsibility. Durable originals remain
service-owned; browser persistence is limited to unsent and unresolved drafts.

## Consequences

The design adds explicit storage, conflict, quota, migration and modal states.
It preserves original bytes, native acceptance correlation, successor content and
private scope isolation at that cost. Browser storage can still be cleared or
evicted, so missing bytes are visible failures, not proof of successful recovery.
Unknown operations and editable drafts are never evicted to free capacity.

Image operations use at least 44px touch targets. Media anchors retain a 2 CSS px
bound without weakening the existing 1 CSS px text-prepend guarantee. Responsive
browser fixtures cannot establish physical mobile behavior or native Provider
acceptance. Carousel navigation, image editing, automatic resend and cross-device
synchronization require separate decisions while retaining the same identities.
