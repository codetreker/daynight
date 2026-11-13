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

Selected originals enter the same transaction as their ordered pending items,
before asynchronous image validation. The Blob record distinguishes an
unvalidated original from verified image metadata; storing bytes never grants
upload or send eligibility. Validation promotes only the original owner, access
epoch, item incarnation and byte identity. A native identity change can release
the old decoder without losing an unrecoverable clipboard image. Reopening its
authorized owner, or explicitly moving the draft, resumes validation from stored
bytes. No background decoder needs authority to publish into a detached target.

Within one draft controller, content writes and upload identity allocation share
a local persistence queue through their version readback, including readback
triggered by network receipts. Queue ownership follows the current draft owner
and authorization generation. Detached reads cannot block a new owner; captured
old-owner writes retain their original identity until they finish. Captured
unsaved content includes unresolved local CAS conflicts, with their original
write baseline and complete attachment bytes. It remains visible even when the
new owner has no saved draft. Changing targets neither chooses the other tab's
saved version nor grants that version to the conflicting local content.
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

A terminal upload replacement changes both wire identities in one storage
transaction. The service retains the Session/image identity even after failure,
expiry or release; a new upload ID alone cannot reuse it. The transaction verifies
the original terminal receipt, absence of an unknown or pending request, current
owner access and exact attachment/upload versions before binding the replacement.
The local attachment ID, original bytes and user content revision remain stable.
Queued edits and retained drafts adopt both new wire IDs without changing their
content. Unknown uploads keep the original IDs and specification for observation
and permitted exact retries.

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
text and any unresolved operation once, without replaying the old input. First
adoption also preserves this tab's legacy input when another tab has already
created the persistent owner. The client distinguishes that input from its own
projected persistent view. New legacy writes use a separate slot for each exact owner, so editing at a
different native target cannot overwrite the original text or unknown-submission
correlation. Fence-only records remain compatible sources: their first authorized
binding adds owner metadata without changing their content, and later consumption
checks the original source and value. Before publishing saved content, the controller retains
the complete local text draft and requires an explicit choice when the complete
contents differ, including equal text with different attachments. Choosing local
content does not combine it with another tab's images. The old storage key remains
until the matching import, explicit choice or accepted original is settled.

A colliding legacy unknown operation enters an internal query-only recovery
namespace with its original real owner identity, fence, kind and correlation. It
uses the existing execution barrier without replacing the current draft or
adding a dispatchable command. Repeated imports validate the same operation
identity and retain terminal deduplication metadata through normal reopening.
Text at the submitted legacy revision remains submitted content; acceptance
consumes it only if the tab has not edited it again. A later text revision remains
a separate conflict choice. Neither content choice drops an unresolved original
operation, and recovery access never becomes editable. Removing all images keeps
the persistent draft and its submission barrier.

The existing AccountSessionProvider owns account invalidation and private-state
cleanup. Waiting for an account refresh stops new draft operations and their
network requests while preserving visible content and local draft editing; it does not revoke or erase
the saved draft. Local editing retains its existing access epoch and CAS; it
cannot reauthorize tombstones written by another tab. Formal reauthorization
checks its own current permission before and inside the storage transaction.
Confirmed session invalidation or explicit logout starts
account cleanup, which first commits an access tombstone and then removes
sensitive draft content. Unknown operations retain only the original identity needed for later
authorized observation. Formal Session authorization reconciles eligible
historical tombstones on every draft load and send preflight, independently of
the current owner's existence or read result. Regaining edit permission also
reconciles an unchanged owner and authorization generation. Admission is checked
at transaction start and before commit, so a detached or revoked controller
cannot reopen access using an earlier permission snapshot. Account cleanup may already have
finished when another Session was opened first. Reconciliation remains
idempotent, preserves existing recovery access epochs and does not create an
image owner for untouched text. Renewed access discovers those tombstones across execution
generations no newer than the verified execution, within the same actor, origin,
resolver, actual Session and original claim or test execution. Storage enforces
`recovery_only` access: dispatched or unknown intent permits original-operation
observation and settlement; prepared intent permits only explicit cancellation.
Neither path creates an old owner's editable draft or grants content, upload or
dispatch access. This historical access classification survives terminal
settlement and subsequent revocation; replacing a revocation reason cannot
restore an old identity's editing rights. Recovery retains the original fence
and operation identity; it neither restores erased private content nor grants
an old generation permission to send. A renewed account cannot read content
before unfinished cleanup completes; a deleted
Session cannot be reopened through this mechanism. Cleanup failures remain
visible and retryable. Local adapters have no fabricated
service resource and use the shared preview store and decoder budgets.

IndexedDB schema version 3 preserves version 1 and 2 records while excluding old
clients from the recovery access model and pending-original representation.
Version 1 code can treat any renewable
blocked owner as eligible for a new editable draft, including during local
offline editing. A truthy recovery marker alone cannot prevent that old
reauthorization path. Version 2 code assumes every Blob has validated image
metadata and can mark a pending original invalid during restoration. Version
change closes older connections; reopening with version 1 or 2 fails instead of
granting obsolete reads and writes. Blocked upgrades and unknown future
versions remain visible storage failures without destructive reconstruction.

Legacy editable items can lack an incarnation even after schema upgrade. An
authorized readwrite snapshot initializes only missing incarnations on the
current editable record before returning it, including records already at
schema 3 and failed submissions restored to editing. Readonly reads and frozen
snapshots stay unchanged. The transaction preserves content, original bytes,
upload bindings, content and storage versions, and save time; it writes the raw
record rather than persisting display-only validation projections. Existing
terminal-retry CAS remains strict, and transaction failure or authorization
loss rolls back the initialization.

Saved-image scopes bind origin, actor, authorization generation and the actual
Session fence/native identity or record namespace/revision. Cache previews retain
only descriptors and explicitly deny resource reads and downloads. Complete byte,
digest and container checks precede publication; local decoding has its own
failure state so unsupported browsers can still download verified originals.
Animation requires complete frame decoding. A static-only fallback cannot accept
unknown or multiple frames. Cancellation revokes publication immediately but
returns capacity only after the actual reader or decoder has stopped.
New consumers of an original whose abandoned read is still draining wait for
that work to finish, then recheck authorization through ordinary acquisition.
They do not inherit the previous consumer's cancellation. Their own cancellation
or asset/scope invalidation ends the wait without starting another read; concurrent
surviving consumers still share one replacement read.

Original reservations follow their remaining preview and download consumers.
Sharing a Blob does not let a finished operation retain the other operation's
capacity. Verified Markdown presentations are bound to their scope and part
identity. A pending body digest keeps that presentation intact until the next
version is admitted, preserving existing image frames without authorizing new
bindings.

## Alternatives

**Reject a new consumer with the abandoned read's cancellation.** This avoids a
drain waiter but makes scrolling an image back into view produce a read error
despite valid access. Starting a replacement immediately instead would overlap
readers and return capacity before the old work stops. Waiting preserves both
the consumer's lifetime and the original reservation.

**Keep attachments in memory or encode them in sessionStorage.** Reloads and
independent text/image writes can lose bytes or submission identity, and Base64
increases storage pressure. Atomic Blob and reference storage makes failures
observable before dispatch.

**Retain pending Files only in detached validation jobs.** This can survive an
in-page target switch but loses the original on reload or page closure. It also
adds a second owner lifecycle for decoder cancellation and late results. Persisting
unvalidated originals lets the existing draft recovery and quota rules own their
lifetime without fabricating a hash, format or image dimensions.

**Edit the frozen submission in place.** This changes operation intent or requires
ambiguous three-way reconciliation. A separate explicit successor preserves both
submitted content and later editing without introducing an automatic queue.

**Use last-writer-wins edits or a localStorage heartbeat lock.** Concurrent tabs can
lose text or dispatch duplicate input. CAS exposes conflicts; Web Locks never
steal a suspended tab's ownership, and persistent dispatch facts survive closure.

**Treat an existing persistent owner as proof that this tab migrated.** Tabs
have separate legacy text storage. Another tab can create the owner first while
this tab still has unsent text or an unknown operation. Adopting that owner
silently loses the local input and can omit its execution barrier. First adoption
must compare complete content and preserve each original operation independently;
copying the local text onto the saved attachments would create an unintended
combined draft.

**Discover retained drafts only through pending operations.** Acceptance and
failure resolution can remove the last recovery entry while later edits still
exist on disk. Independent discovery plus an explicit, version-bound move keeps
those edits usable without automatically importing old-target content.

**Use send identity for historical query authorization.** An exact execution
generation is necessary for new commands, but restricting recovery to that
generation strands earlier unresolved operations after account cleanup. Verified
recovery scope permits observation of the original intent without restoring its
private content or widening current command admission.

**Reconcile historical access only after a blocked current-owner read.** Opening
another Session can finish account cleanup before the original Session is
visited. Its new current owner may be absent or readable, leaving old operations
hidden indefinitely. Reconciliation belongs to formal Session authorization,
not an exceptional result from reading the current draft.

**Add a recovery marker without changing the database version.** Older bundles
can ignore a new flag or reinterpret a blocked marker through their existing
reauthorization path. The database version barrier prevents those clients from
rewriting an owner under obsolete access rules while preserving stored content.

**Initialize item incarnations only during a database version upgrade.**
Already-upgraded databases can still contain legacy records without the field.
Initializing during authorized editable access covers those records without
rewriting frozen operation snapshots. Deferring initialization until terminal
replacement would also change the token alongside wire IDs, preventing a
concurrent local edit from recognizing the same item when merging upload state.

**Mark the owner inside a shared legacy storage slot.** The marker prevents a
reader from adopting another native target's text, but a new target still writes
the same slot and destroys the original. Each exact owner needs a separate write
location; compatible fence-only sources retain their ownership and conditional
consumption independently.

**Keep the wire image ID when replacing a terminal upload.** Treating it as the
local attachment identity preserves the visible item, but conflicts with the
service ledger: terminal and released uploads still reserve that image ID. A
separate stable local attachment ID preserves the UI and original bytes while
atomic replacement gives the new upload a new wire image identity.

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
