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
The original decision established the browser design before its runtime existed.
Shared saved-image display, preview and persistent drafts use the existing Session
clients and archive reader. `TaskSessionClient.imageDrafts` owns the draft
controller; the original command and operation reader remain its transport.
IndexedDB owns immutable original Blobs, content revisions, references and frozen
operation intent. Short transactions
with CAS protect concurrent tabs. Web Locks coordinate network mutations, while
a durable single transition grants dispatch ownership. Unknown results retain
the original operation and block another send.

Within one draft controller, content writes and upload identity allocation share
a local persistence queue through their version readback, including readback
triggered by network receipts. Queue ownership follows the current draft owner
and authorization generation. Detached reads cannot block a new owner; captured
old-owner writes retain their original identity until they finish. Captured
unsaved content remains visible even when the new owner has no saved draft.
Failed saves can retry under the original identity; competing saved content
requires a choice bound to both the captured write and displayed source version.
Neither choice changes the current input. Each queued allocation
rechecks the current owner, byte revision and upload identity. This prevents
overlapping selection or recovery work from conflicting with its own CAS writes.
Network transfers remain outside that queue so editing does not wait for them;
successful content writes resume eligible uploads after temporary dirty-state
admission pauses. Waiting upload work rechecks the latest state before resuming;
unknown requests retain their explicit recovery rules, and
cross-tab writes still require the database's version checks. Operation observation,
settlement and send preflight use the same queued content-conflict check: a new
operation receipt cannot advance the write baseline of unsaved content over
another tab's successor edit.

An explicit successor draft permits local editing without changing the frozen
submission. Native acceptance settles only the original draft identity and
revision. Text and attachments switch together when the owner changes; an old
image draft cannot become a new target's text-only input. Native commands that
consume an active persistent text draft freeze its exact revision through the
same dispatch ownership and settlement mechanism as messages.
Their command payload remains unchanged; controls that do not consume input leave
the draft intact. Both paths observe the durable execution barrier, including
after a fresh tab receives no operation receipt. Historical intents remain
discoverable for the same authenticated actor, resolver, actual Session and
original claim or test execution across execution generations. They retain their
original fence for observation without entering the new editable
draft. Failure recovery binds the original owner, operation and displayed draft
versions; a competing edit invalidates confirmation before either draft is
discarded. Retained editable drafts are discovered independently of unresolved
operations, so acceptance or a failure choice cannot hide later edits. An explicit
move into an empty current draft binds both displayed versions, changes ownership
in one transaction, and revalidates the bytes with new image and upload identities.
It neither rewrites an old operation nor overwrites current input.

Remote upload release bookkeeping does not pin local originals. Once editable,
frozen and unresolved submission references end, collection removes the local
Blob and its quota charge while preserving the original release identity. Old
native targets therefore do not need to become current again to reclaim local
capacity. Scoped adapters provide verified leases to one preview host per real
Session or read-only record. Bounded page caches remain separate from durable
service references and browser draft storage. Preview lives inside the actual
Session presentation root, with explicit coordination for higher authentication
and deletion dialogs.

Pane lifetime retains its existing cache ownership; the
[Bot cache decision](../../archived/architecture/2026-11-04-bot-session-cache.md)
records that choice. The image design adds persistent Blob ownership outside that
cache; evicting a pane does not authorize deleting a draft. Untouched text-only
drafts retain their existing path. Activating an image draft imports its current
text and any unresolved operation once, without replaying the old input. Removing
all images keeps the persistent draft and its submission barrier.

Account cleanup first commits an access tombstone, then removes sensitive draft
content. Unknown operations retain only the original identity needed for later
authorized observation. A renewed account cannot read content before unfinished
cleanup completes; a deleted Session cannot be reopened through this mechanism.
Cleanup failures remain visible and retryable. Local adapters have no fabricated
service resource and use the shared preview store and decoder budgets.

Saved-image scopes bind origin, actor, authorization generation and the actual
Session fence/native identity or record namespace/revision. Cache previews retain
only descriptors and explicitly deny resource reads and downloads. Complete byte,
digest and container checks precede publication; local decoding has its own
failure state so unsupported browsers can still download verified originals.
Animation requires complete frame decoding. A static-only fallback cannot accept
unknown or multiple frames. Cancellation revokes publication immediately but
returns capacity only after the actual reader or decoder has stopped.

Original reservations follow their remaining preview and download consumers.
Sharing a Blob does not let a finished operation retain the other operation's
capacity. Verified Markdown presentations are bound to their scope and part
identity. A pending body digest keeps that presentation intact until the next
version is admitted, preserving existing image frames without authorizing new
bindings.

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

**Discover retained drafts only through pending operations.** Acceptance and
failure resolution can remove the last recovery entry while later edits still
exist on disk. Independent discovery plus an explicit, version-bound move keeps
those edits usable without automatically importing old-target content.

**Retain local bytes until remote upload release completes.** A detached target
may no longer have release permission, pinning accepted images against the browser
quota. Remote bookkeeping needs its identity and receipt, not the original Blob;
content references remain the authority for local byte retention.

**Use an independent Blob and new browser tab for each card.** Collapse causes
repeat reads, while revocation, Escape and focus lose a common owner. Shared
scope leases preserve stable rendering and centralize cleanup.

**Portal one preview to document.body.** Existing fullscreen inert regions and
Task focus boundaries can exclude it. Root-local dialog hosting preserves those
boundaries; higher dialogs require a synchronous suspension bridge.

**Clear image renderers during every body verification.** This makes admission
simple but destroys already verified frames, focus and decoded leases during
ordinary text updates. Keeping the last verified presentation within the same
identity preserves those resources while new bindings remain untrusted.

**Persist all viewed images or add cross-device drafts.** Both expand private
retention, synchronization and cleanup responsibility. Durable originals remain
service-owned; browser persistence is limited to unsent and unresolved drafts.

## Consequences

The design adds explicit storage, conflict, quota, migration and modal states.
It preserves original bytes, native acceptance correlation, successor content and
private scope isolation at that cost. Browser storage can still be cleared or
evicted, so missing bytes are visible failures, not proof of successful recovery.
Unknown operations and editable drafts are never evicted to free capacity.
The browser implementation does not grant production image capability. Provider
send and steer remain unavailable until their complete service and native profile
qualifications are established. Controlled browser transport proves draft,
persistence and UI behavior, not native image acceptance.

Composer height reservation counts only its own direct error, while attachment
and historical recovery errors stay inside their bounded content area. Resize
observation schedules dimension writes for the next animation frame rather than
changing the observed surface during delivery. Image operations use at least 44px
touch targets. Media anchors retain a 2 CSS px
bound without weakening the existing 1 CSS px text-prepend guarantee. Responsive
browser fixtures cannot establish physical mobile behavior or native Provider
acceptance. Carousel navigation, image editing, automatic resend and cross-device
synchronization require separate decisions while retaining the same identities.
