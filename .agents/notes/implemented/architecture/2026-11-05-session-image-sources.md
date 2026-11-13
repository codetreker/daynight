# Agent Note: Image sources become authorized immutable snapshots

Status: implemented

## Problem

A path or URL in message text neither proves an image occurrence nor grants
access to its target. Loading it again can reveal another account's data or
silently replace historical content. Streaming Markdown can also change an
apparent image into code, and path or DNS checks can race the eventual read.

## Decision

The adopted [source design](../../../../docs/design/session-image-sources.md)
uses AST-based discovery, durable original-position registration, handle-based
local reads, a credential-free network transport and immutable first-success
snapshots. Its original publication established the design before the source
consumers existed; it did not establish runtime implementation or security
acceptance.

The [Windows ancestry decision](2026-11-10-windows-image-source-handles.md)
partially replaces the original option to rely on write/delete sharing around
complete pathname opens. It preserves that option's original rationale and the
attribute-write failure that requires parent-handle traversal.

The Controller's [Markdown modules](../../../../packages/daynight/src/commands/controller/markdown/)
separate parsing, projection, durable source coordination and byte acquisition.
The parser runs CommonMark/GFM analysis in a bounded, terminable worker. The
projector preserves full text, stable part identities and version-bound UTF-16
bindings. Removed or rewritten images remain in their original entry's retained
container, including late committed captures. Failed analysis preserves readable
text and existing image ownership without authorizing a partial node collection.

Provider `onTimeline(entry, metadata?)` supplies `complete`, `format` and
`truncated` independently. Only trusted final native blocks or complete history
establish completion; deltas and active historical turns do not. Raw tool/JSON
content remains plain, and missing block identity cannot be replaced with array
position. Completion grants no file permission. Runtime accepts text
synchronously and advances parsing and capture independently, so media work does
not delay native receipts. First source IO waits for complete, untruncated
Markdown and its original position acknowledgement.

Projection state, source intents, contexts and request admission use the existing
journal's `image_runtime_state` and metadata budget. A source intent preserves
the original occurrence, locator, context and capture/attempt identity before
position registration. Recovery repairs an interrupted registration and waits
for the original position's service ACK and actual complete history before local
reservation or source IO. The [direct-submission decision](2026-11-13-session-direct-image-submission.md)
replaces the original register/reserved prerequisite with sealed-byte submission.
A persisted receipt can repair an interrupted timeline update without
changing the occurrence. Unknown submissions query the original capture and
replay only the same frozen business content and sealed bytes after an explicit
authorized absence result; an interrupted source writer is never restarted by recovery. A source
intent becomes settled only after committed-byte adoption and its original
position projection both succeed.

Native image publication and Markdown projection share the current committed
entry. The named Markdown publication operation commits projection state with
the current SQL body, totals and outbox in one SQLite transaction. The
[atomic publication decision](2026-11-10-atomic-content-publication.md) owns the
original visibility guarantee; [SQL activation](2026-11-12-session-sqlite-activation.md)
replaces its candidate pointer with the body row.
Before parsing, receipt updates or stop settlement, Markdown state adopts
same-position native image updates and invalidates stale parser tokens. This
also closes the crash window between a native patch and Markdown state repair.
Only an exact durable original-input text match establishes completion for an
accepted mixed input. Publication adoption does not repeat native occurrences
or change the original receipt and image indexes; failure carriers follow the
native body with the text predecessor required by the timeline protocol.

The current local context uses the verified execution cwd as one export root.
Its device/inode identity is captured before Provider output and persisted with
the context. `createLocalImageContext` passes that identity as `expectedRoot` to
the helper, which compares the actual root fd before traversal. Opening a helper
later cannot adopt a replacement directory at the same pathname. The POSIX
helper retains root and ancestor fds, expands checked links and parent components,
and checks file identity, length and nanosecond timestamps around copying.
Darwin identifies APFS/HFS by the native `f_fstypename` and `MNT_LOCAL` fields
and rejects userspace mounts marked `MNT_EXT_FSKIT` in the extended flags. Its
`f_type` is a kernel registration number rather than a stable filesystem magic.
Linux retains its filesystem-magic allowlist.
Trusted document directories or additional roots still require explicit authority;
text cannot supply them.

The helper reports bounded source evidence from its actual held-handle traversal:
the requested locator and parsed path, root identity, component and link/reparse
expansions, and the final opened object. The initial checkpoint precedes source
resolution; the opened checkpoint precedes content reads. Block and final
checkpoints retain that same source evidence. Controller checks the message
structure, stage order and source binding before forwarding evidence to the
policy consumer. A second pathname resolution cannot describe a different object
as the held source. Evidence remains inside the helper/Controller boundary and
never enters the Session journal, timeline or public diagnostics. Strings are
limited to 8192 UTF-8 bytes; each traversal holds at most 4096 events and 262144
encoded bytes, with a separate 262144-byte ceiling on the complete checkpoint
message. Traversal enforces its bounds while accumulating events, before source
content reads. Long or expanding paths can therefore fail closed without an
unbounded evidence allocation.

External HTTP(S) has a separate HTTP/1.1 transport. It checks every DNS answer,
redirect and actual peer, uses pinned approved addresses, verifies TLS identity
and sends no account credentials. `createExternalImagePolicy` requires a trusted
egress check and durable per-request charging. Successful bytes pass through the
common complete decoder and service capture flow; later reads use the saved
immutable resource.

The [deployment-profile decision](2026-11-10-image-egress-profiles.md) supplies
the production policy source. Trusted local configuration declares protected
destinations and existing egress conditions; current host interfaces and all
DNS, connection and peer targets participate in the guard. Configuration or
network changes invalidate the attempt's generation. This does not claim that
application checks independently verify the operator's deployment facts.

Source writers reserve both the source and validation-copy peak through the
existing media budget. `reserveCaptureSource` and relay block delivery share
`tryAcquireMediaBlock`, keeping the Controller's total at two block slots.
`readCapture` verifies and delivers each block synchronously while holding its
policy lease. Cancellation waits for the writer and validation work before
releasing their reservation; shutdown preserves unknown and retained ownership.
After writer and stage completion and durable release, the in-memory shared slot
is returned even when refreshing the storage budget fails. That error still
reaches the caller. A repeated release reconciles an active slot whose durable
record already says released; it must not return a slot while joining or release
persistence remains unconfirmed.

Local cleanup has a durable obligation separate from the service receipt and
source phase. Before reserving source storage, the coordinator records the
original capture and attempt to release. Only confirmed release clears that
obligation; its last error remains separate from the source failure and its
original retry delay. Recovery retries local cleanup even after service settlement
or while the original service
outcome is unknown, without reopening the source. A new attempt cannot replace
the previous cleanup identity or start a writer until that obligation is resolved.
Receipt-driven attempt changes persist the new identity, its retry wait state,
and the removal of the previous source error together, before timeline projection.
Older started records acquire the same conservative cleanup obligation on recovery.

`media.adoptCaptureResource(captureId, attemptId, resource)` requires a durable
committed receipt matching the original request, occurrence and complete resource,
and checks every validated metadata field. It takes a shared IO slot and admits
the third saved-copy peak before `ResourceFiles.importResourceFile` imports
the validated file in 512 KiB blocks. An existing saved original is verified
in place; missing or corrupt bytes cannot be repaired from staging or an old
source. This keeps local adoption from silently replacing committed history.
The [resource ownership decision](2026-11-12-session-resource-files.md) describes
the file owner and the guarded deletion used during import cleanup.

Source retry is one operation on an already-registered occurrence. Unknown
captures are observed under their original identity. Only a confirmed failed,
never-committed local/external source with released reservation may be prepared
again; saved resources are never refreshed through retry. Querying a new
service retry attempt persists `awaitingRetry` and observes it without starting
a writer. Only the original `retry_capture` control can start that attempt after
the prior writer and reservation have stopped and current permission is checked.
Local and external retries go through their source coordinator before the generic
cached-stage shortcut. Validated bytes without matching source admission cannot
be reported as a successful retry. Recovery keeps the original identities and
settles the incomplete attempt without reopening its source.

Confirmed format and complete-decode failures retain their structured category
across the helper boundary, so fixing a never-committed source can remain
retryable. A worker crash, IO failure or unknown error cannot be classified as
bad image content from its message. Sharp can report both IO failures and bad
content as an unstructured Error, so those ambiguous failures remain unavailable;
only explicit validation checks establish a content rejection. A retry refused
before source work because
both source slots are occupied returns `rate_limited` through the relay. The
service reoffers the original request rather than terminalizing that attempt;
capacity pressure has not read or invalidated the source.

## Alternatives

**Scan paths or image-looking strings with regular expressions.** Such scans
read code and ordinary links while missing reference definitions and Markdown
escaping. A shared AST with exact text offsets preserves syntax and authorization.

**Let the browser load file, relative or external src values.** Browser paths do
not identify Controller files, and direct external loads introduce credentials,
CORS, mixed-content and historical-content dependencies. Only verified saved
bytes enter the browser image element.

**Split Markdown into text and image fragments.** Fragmentation loses shared
definitions, list/table context and linked-image semantics. Full text plus exact
bindings keeps the document intact while the image reader remains controlled.

**Read as soon as streaming syntax appears closed.** A later fence or definition
can change its meaning. Waiting for trusted completion delays initial display
but avoids irreversible IO for text that ultimately is not an image.

**Check realpath and then call ordinary open.** The final path or an intermediate
directory can change between operations. Handle-relative traversal costs native
platform code and race tests but preserves the checked object boundary.

**Give policy consumers only a stage or a newly resolved pathname.** A stage
cannot identify the checked source, and resolving the pathname again can select
a replacement after the helper opened it. Carrying bounded evidence from the
actual traversal preserves object association without prescribing a native
authorization wire protocol.

**Use a general service URL proxy or fetch only at archive time.** A proxy adds
a second network execution and authorization surface. Delayed fetching cannot
recover an earlier version after a source changes or disappears. Controller
capture reuses the existing trusted occurrence and bounded byte pipeline.

**Refresh a saved image when a read fails.** This can replace historical bytes
without a new occurrence and conceal storage damage. A new source version needs
an explicit new occurrence; corruption remains a visible read failure.

**Treat cached validated bytes as sufficient for a source retry.** Validation can
commit before source admission. Reporting those bytes as retry success lets the
service enter copying while every transfer rejects the missing admission. The
coordinator owns that association and must validate even a cached result.

**Return shared slots only after a successful budget refresh.** Free space can
fall below its floor after release is durable. Keeping the slot in that case
turns a recoverable storage error into permanent capacity loss. Returning the
slot after proven cleanup preserves the error without retaining dead work.

**Use service settlement as proof of local cleanup.** A failed service capture
can be terminal while directory synchronization or release persistence is still
failing locally. Skipping that record loses the only cleanup retry, and replacing
its attempt loses the reservation identity. A separate durable obligation keeps
cleanup recoverable without repeating source IO or revising the service result.

## Consequences

The design adds platform opener, parser-version, network-policy and retained
metadata maintenance. Network address checks need deployment egress guarantees
where transparent routing could map public destinations into private networks.
Without equivalent isolation, external capture stays disabled.

The initial source foundation had no production native authority or deployment
egress proof and therefore refused both kinds of source IO. The
[single-checkpoint authority decision](2026-11-10-single-checkpoint-native-read-authority.md)
adds a pinned Codex subset and separates native source admission from access to
an already admitted immutable copy. Object evidence alone still grants no Read
permission. Each checkpoint needs the native decision applicable to that
operation; a complete snapshot export or per-block lease RPC is not mandatory.
The Controller's own permission changes invalidate and drain writers first.
Validated Copilot model and reasoning-effort settings preserve the existing
authority on success and do not reload skills; failed or uncertain settings
close it. Each later source checkpoint still obtains a fresh native decision.
Other native changes constrain subsequent admissions without retrospectively
revoking completed source reads. Daynight scope revocation still prevents late
publication. Unsupported Provider configurations and absent deployment egress
proof remain explicit gaps; controlled fixtures cannot establish either.

The Windows opener uses `CreateFileW` only for the initial local drive root.
Every later component is opened with `NtCreateFile` relative to its held parent
handle and with `FILE_OPEN_REPARSE_POINT`. Denying write/delete sharing protects
contents and renames but cannot stop attribute-only handles from changing a
directory into a junction; pathname reopening would therefore be unsafe.
Known symlink/junction substitutions and cwd aliases are resolved explicitly;
absolute prefixes must reach the original root ID. Volume serial and complete
file IDs preserve checked objects. Only NTFS is accepted: the persisted Node
stat identity is insufficient to identify ReFS files uniquely. Sharing conflicts
remain observable. Its real-handle tests include an attribute-only junction
mutation with unchanged file ID. Handle validation must execute on each supported
platform; another platform's result or a source branch does not qualify it.
Intel macOS is outside the current supported platform set. The
[provider scope decision](2026-11-11-image-provider-scope.md) partially supersedes
the original all-provider target: Claude source support is outside the current
image scope and stays denied. Unsupported Codex/Copilot profiles and unverified
deployment facts do not relax the remaining acceptance requirements. The source consumers and configured policy producers do not by
themselves establish complete automatic source capture or end-to-end availability.

Permission is checked throughout preparation and exported-block delivery, but
already-lawfully-delivered bytes cannot be remotely erased. Local file checks
detect ordinary concurrent modification without claiming transactional snapshots
or isolation from malicious processes sharing the same OS identity.

Completed snapshots survive source changes and Controller shutdown. Unknown
commits retain pins and original identity; they cannot be turned into archive
partial success. Retained bindings and withdrawn containers consume admission
budgets and stay part of authorization, deletion and archive closure.

Private-network sources, authenticated fetching, arbitrary files and refreshing
existing history remain separate capabilities. Future extensions must retain
opaque authority, immutable resource identity and explicit source operations
rather than treating a path, URL or digest as permission.
