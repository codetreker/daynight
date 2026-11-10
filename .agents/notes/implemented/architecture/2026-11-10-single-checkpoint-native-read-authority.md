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

## Consequences

The common consumer accepts asynchronous native decisions without weakening the
synchronous media publication fence. Crash recovery has an explicit durable
boundary between an unadmitted stage file and a validated acquired copy.

The Codex profile is deliberately narrow. Other versions, restricted profiles,
remote environments and enabled pre-tool hooks refuse new capture. A failed
authority does not reopen within the same execution. This does not claim that
other configurations are inherently unsupported; adding one requires native
semantics and observable coverage, not another permissive flag.

Claude and Copilot authority integration and deployment egress proof remain
separate incomplete conditions of the full source capability. Native API shapes,
controlled fixtures, OS handle tests and real Provider acceptance are distinct
evidence. The [source design](../../../../docs/design/session-image-sources.md)
owns the complete current mechanism and validation boundaries.
