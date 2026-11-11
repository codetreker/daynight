# Agent Note: Native permission admits one source checkpoint

Status: implemented

## Problem

A local Markdown image can be readable by the Controller's OS identity while
remaining forbidden to its native Session. Conversely, a later change to source
permissions must not turn a previously obtained immutable image into a new
source read. Conflating those checks either bypasses a native restriction or
makes valid saved content depend on its old pathname indefinitely.

The [source foundation](2026-11-05-session-image-sources.md) provided held-object
proof, cancellation and a synchronous policy consumer. It initially supplied no
production authority. A single policy snapshot with delayed change notifications
cannot safely grant later reads, but that does not make a native lease or an
exported global permission epoch the only possible interface.

## Decision

The Provider supplies a `NativeReadPolicy` bound to its native Session, trusted
cwd and authority instance. Its synchronous `verify()` checks that local binding
and connection; it grants no source IO. Its asynchronous `authorizeCheckpoint()`
obtains a decision for exactly one initial, opened, block or final checkpoint.
The helper permits only one outstanding checkpoint. The Controller checks the
same policy instance and Daynight scope before and after the response, and never
reuses the response for another block, source or attempt.

The native decision is the admission point for that operation. A later native
restriction affects subsequent admissions; it does not retroactively revoke a
read already admitted. Daynight actor, Session and execution fences remain a
separate publication boundary and reject late results after their invalidation.
For native changes initiated by the Controller, closing the local gate and
joining source writers before sending the change provides a stronger, simple
ordering. An unknown transport or authority state stays closed.

Codex support is pinned to 0.167.0. The Provider requires an exclusively owned
stdio process, observed disabled remote control, and the actual start/resume
snapshot for the expected thread/cwd. The supported snapshot has unrestricted
FS, no active named profile, approval policy `never`, and a single local
environment rooted at the same cwd. This conjunction is a property of the pinned
native implementation, not an inference from requested CLI flags. It leaves
the source root and OS restrictions intact and never widens the user's sandbox.

The pinned native start sends its response before a `thread/started` notification.
Provider continuation and policy installation can fall on either side of that
notification. The authority associates one notification with its own start
request and the complete returned thread snapshot, with `turns` cleared as in
the native notification. With no start association before installation, a
notification invalidates authority. After the start response, notifications for
other threads do not affect that association. A duplicate or different snapshot
for the current thread still invalidates authority. Resume grants no such
allowance. Matching only the thread
ID would hide later lifecycle changes; invalidating every notification would
close a normally started thread before its first source read.

Startup regressions distinguish a restriction received before the start response
from one received after policy publication. The former cannot publish authority;
the latter invalidates the issued binding before its next checkpoint. Separate
stdout writes do not fix either order relative to installation. The live fixture
sends the early restriction before its older response and uses the Provider's
subsequent model-list request to place the late restriction after installation.
Both cases retain a usable text Session and prohibit the next source read.

Every checkpoint also calls the loaded thread's `hooks/list`. Unknown structures,
warnings, errors and enabled `PreToolUse` hooks refuse capture; the adapter does
not interpret scripts or disable user hooks. A background plugin change cannot
hide behind a startup-only list. An admitted checkpoint is consumed once, while
the next checkpoint asks again. Any authority failure closes that execution's
source gate until a native execution is rebuilt and verified.

The profile relies on the configured executable and its actual initialization
version response. It is not a production binary signature or digest check.
Source references for the native facts are pinned to
[`086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`](https://github.com/openai/codex/tree/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a):
the [thread snapshot response](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/thread_processor.rs#L1673),
[permission projection](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/protocol/src/permissions.rs#L775),
[loaded hook enumeration](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/catalog_processor.rs#L626),
and [background hook refresh](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/effective_plugin_change.rs#L22).

Copilot uses the actual root Session's native permission route through a private
preload in the unmodified CLI distribution. This profile requires SDK 1.0.11,
CLI 1.0.105 and macOS ARM64; executable and internal ABI artifacts are checked
by digest before loading. The existing SDK/TCP connection remains the Session
owner. Every checkpoint checks identity, current mode, complete hook state,
strict path exclusions and the native Read result. Held-object proof must be an
ordinary lexical chain without links, parent traversal, dot or empty components.
Unsupported artifacts
retain the ordinary text provider and do not receive image authority.

Native permission routing may ask the SDK even when an API name suggests a
check-only operation. Image requests therefore have precise, authenticated
correlation and receive a rejection from that callback, never an approval.
Only native automatic approval can admit source IO. The supported manual and
allow-all modes, the pinned managed-mode lifecycle and the exclusive mutation
boundary prevent the request from invoking an assisted model judge. Current
mode is still queried for every checkpoint; a startup flag is insufficient.

A fixed private ClientMetadata key authenticates request markers and refusal
receipts across resume. Live matching also requires issuance, Session context
and the same request object as `event.data.permissionRequest`. Historical
suppression requires both a valid
request marker and a refusal receipt bound to its actual native request ID.
Unfinished records retain expired/unknown history rather than a fabricated
completion. Ordinary tool interactions remain on their existing path. The key
is initialized only when absent and read back; unknown writes are not replayed
or repaired by rotating it. Historical association does not depend on the
current Session still qualifying for image reads.

The SDK runs in its owned bridge worker. A worker-private random identity
preserves the SDK's shared permission request object across serialization;
the facade verifies Session, complete request content and identity before
restoring that correspondence. Permission callbacks precede their events as
they do in the SDK, avoiding a callback/event dependency cycle. Identity alone
grants no native permission. A separate bounded permission-history scan
authenticates complete refusal pairs before ordinary cursor-based projection;
unknown or over-budget scans disable image authority and leave original
interactions and text delivery available.

An IPC deadline disables Copilot image authority without terminating a healthy
text Session. At most one uncancellable native request may remain; late allows
are ignored and its own late permission callback is still refused. Provider
shutdown owns runtime termination and ordinary extraction cleanup.

Only after final admission, successful helper completion, full image validation
and a current Daynight scope does the coordinator persist `sourceAdmission`.
The enclosing source record binds the capture and context; admission binds the
attempt, policy revision, proof digest and complete validated image metadata.
It stores a fact about the acquired copy, not a future source capability. The
raw path traversal proof remains transient.

Media transfer verifies that fact against the same immutable preparation and
current Daynight scope synchronously with delivery. Later native source denial
does not authorize a new read or invalidate the saved bytes. A new attempt must
obtain fresh source decisions. Recovery with a staged file but no matching
admission fails without committing or repeating source IO; unknown service
outcomes retain their original capture identity.

## Alternatives

**Require a global native epoch or pre-change notification for every read.** This
would support a long-lived policy mirror but is stronger than single-operation
admission needs. Native permission changes need not undo operations they already
admitted. The earlier conservative assumption was useful while the consumer had
only a synchronous policy callback; it does not justify retaining a cached allow.

**Use a mode flag or initial empty hooks list as a root-wide permit.** Those
values do not cover current effective restrictions. Codex background plugin
refresh can change its hooks independently of the Controller's RPCs. The adapter
uses the native resolved FS subset and a fresh loaded hook query per checkpoint.

**Recheck source permission while transferring a validated private copy.** That
would confuse an existing resource with new IO at its old source. The admission
record and immutable bytes establish what was obtained; the current Daynight
scope determines whether it may be transferred. Neither authorizes recapture.

**Run a different native Session as an authorization oracle.** Its policy and
changes do not belong to the actual Session. Source decisions must use the live
instance that owns the output and preserve its user configuration.

**Infer that a permission route cannot ask, or precheck an allow-all snapshot.**
The pinned Copilot routes can invoke the SDK callback, and a precheck does not
remove the subsequent decision. Precise image-request rejection preserves the
native decision without opening an interactive approval for background capture.

**Hide all permission events with an image-looking intention prefix.** Ordinary
tool requests can copy text. Authenticated issuance handles live events; a
second signature binds a completed historical refusal to its native request ID.
An incomplete crash record remains visible as expired/unknown when that proof
is absent.

## Consequences

The common consumer accepts asynchronous native decisions without weakening the
synchronous media publication fence. Crash recovery has an explicit durable
boundary between an unadmitted stage file and a validated acquired copy.

The Codex profile is deliberately narrow. Other versions, restricted profiles,
remote environments and enabled pre-tool hooks refuse new capture. A failed
authority does not reopen within the same execution. This does not claim that
other configurations are inherently unsupported; adding one requires native
semantics and observable coverage, not another permissive flag.

The original authority decision included Claude integration as an incomplete
source condition. The [provider scope decision](2026-11-11-image-provider-scope.md)
removes Claude from the current image delivery target while retaining its refusal
behavior and existing compatibility. Real deployment egress validation remains
a required condition. The Copilot
profile adds an internal ABI and signed-history maintenance cost; unsupported
versions and platforms fail closed. Native API shapes, controlled fixtures, OS
handle tests and real Provider acceptance are distinct evidence. The
[source design](../../../../docs/design/session-image-sources.md) owns the complete
current mechanism and validation boundaries.
