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
for the original position's service ACK before register, reservation or source
IO. A persisted receipt can repair an interrupted timeline update without
changing the occurrence. Unknown register/commit outcomes query the original
capture; an interrupted source writer is never restarted by recovery. A source
intent becomes settled only after committed-byte adoption and its original
position projection both succeed.

The current local context uses the verified execution cwd as one export root.
Its device/inode identity is captured before Provider output and persisted with
the context. `createLocalImageContext` passes that identity as `expectedRoot` to
the helper, which compares the actual root fd before traversal. Opening a helper
later cannot adopt a replacement directory at the same pathname. The POSIX
helper retains root and ancestor fds, expands checked links and parent components,
and checks file identity, length and nanosecond timestamps around copying.
Trusted document directories or additional roots still require explicit authority;
text cannot supply them.

External HTTP(S) has a separate HTTP/1.1 transport. It checks every DNS answer,
redirect and actual peer, uses pinned approved addresses, verifies TLS identity
and sends no account credentials. `createExternalImagePolicy` requires a trusted
egress check and durable per-request charging. Successful bytes pass through the
common complete decoder and service capture flow; later reads use the saved
immutable resource.

Source writers reserve both the source and validation-copy peak through the
existing media budget. `reserveCaptureSource` and relay block delivery share
`tryAcquireMediaBlock`, keeping the Controller's total at two block slots.
`readCapture` verifies and delivers each block synchronously while holding its
policy lease. Cancellation waits for the writer and validation work before
releasing their reservation; shutdown preserves unknown and retained ownership.

`media.adoptCaptureResource(captureId, attemptId, resource)` requires a durable
committed receipt matching the original request, occurrence and complete resource,
and checks every validated metadata field. It takes a shared IO slot and admits
the third saved-copy peak before `pending-content.importResourceFile` imports
the validated file in 512 KiB blocks. An existing saved original is verified
in place; missing or corrupt bytes cannot be repaired from staging or an old
source. This keeps local adoption from silently replacing committed history.

Source retry is one operation on an already-registered occurrence. Unknown
captures are observed under their original identity. Only a confirmed failed,
never-committed local/external source with released reservation may be prepared
again; saved resources are never refreshed through retry. Querying a new
service retry attempt persists `awaitingRetry` and observes it without starting
a writer. Only the original `retry_capture` control can start that attempt after
the prior writer and reservation have stopped and current permission is checked.

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

**Use a general service URL proxy or fetch only at archive time.** A proxy adds
a second network execution and authorization surface. Delayed fetching cannot
recover an earlier version after a source changes or disappears. Controller
capture reuses the existing trusted occurrence and bounded byte pipeline.

**Refresh a saved image when a read fails.** This can replace historical bytes
without a new occurrence and conceal storage damage. A new source version needs
an explicit new occurrence; corruption remains a visible read failure.

## Consequences

The design adds platform opener, parser-version, network-policy and retained
metadata maintenance. Network address checks need deployment egress guarantees
where transparent routing could map public destinations into private networks.
Without equivalent isolation, external capture stays disabled.

The real runtime supplies neither `nativeReadPolicy` nor `externalPolicy`, so
local and external source IO fails closed with `policy_restricted`. The private
native policy callback currently has only `{revision, verify(): void}`; that API
alone cannot prove path-specific Read rules, the resolved symlink target or a
revocation generation. A sandbox/profile name, permission mode or successful tool
read is not that proof. Controlled policy and network fixtures cannot enable real
Provider collection or establish deployment egress isolation.

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
Intel macOS is outside the current supported platform set. Native authorization
and deployment egress remain unmet requirements, not approved deferrals. The
source consumers do not yet establish complete automatic source capture or
end-to-end availability.

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
