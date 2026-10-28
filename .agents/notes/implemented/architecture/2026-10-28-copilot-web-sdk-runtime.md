# Agent Note: Copilot Web SDK Runtime Ownership

Status: implemented

## Problem

Copilot tasks need the same browser timeline and basic session interactions as
other Web tasks. Adding a provider name to the protocol does not establish a
native writer, recoverable session identity, trustworthy input receipts or
stopping evidence. A native process hidden behind a client library can escape
the worker's existing lifecycle accounting.

## Decision

Copilot Web uses SDK 1.0.11 with bundled CLI 1.0.83. The Controller starts the
platform executable directly in headless mode, records the actual child through
`onSpawn`, and connects using `RuntimeConnection.forUri` over loopback TCP with a
random private connection token. The child remains within the Controller's
process group or Windows Job. This extends the original provider scope of the
[claim-frozen session mode decision](2026-10-27-task-session-mode-contract.md);
Codex retains private app-server stdio, Claude retains its SDK, and Herdr retains
its independent TUI execution path.

The native profile is frozen as `COPILOT_HOME`. Session creation and exact resume
verify native identity, working directory and ownership before enabling input.
Model and effort are omitted when not configured so native defaults remain
native defaults. Copilot Web accepts only `--effort low|medium|high|xhigh`.
History and live events use the existing typed timeline and interaction model;
the browser gains no separate Copilot UI or session directory.

A successful native send returns a native message ID. A late successful result
from the same live call can confirm its captured operation ID after a timeout.
There is no caller operation ID in native history that permits recovery-time
input reconciliation. Lost ACKs remain unknown across process loss, and neither
matching prompt text nor idle activity permits replay. Native immediate mode is
the steer mechanism; foreground interrupt is distinct from session shutdown.
Permissions, questions, forms and plan responses await matching native completion
rather than treating a callback return as confirmation. Plan approval uses the
generic form with exit-only, interactive, rejection and optional feedback;
autopilot and URL elicitation are outside the supported control path.

The SDK regards a `forUri` connection as externally owned. Controller shutdown
therefore requests native runtime shutdown explicitly before bounded transport
closure and TERM/KILL fallback. The worker's independent stop proof remains the
condition for cleanup and a new execution generation. Native process exit or a
failed health check rejects pending work, preserves unknown input outcomes and
notifies the Controller to close its provider, relay and IPC before exiting.
The worker can then prove the old process boundary stopped and resume the same
native session. Initialization defers fatal cleanup until the provider handle
exists, and readiness requires both that handle and the initial relay sync;
an early local initial-submit request records no dispatch intent. Detailed lifecycle and
wire behavior belong to the [session design](../../../../docs/design/task-session-protocol.md#copilot-sdk-与私有-runtime).

Dependency declarations receive narrow, version-pinned patches: an omitted SDK
delete-event metadata property is declared `metadata?: never`, and JSON-RPC's
`LinkedMap` no longer claims to implement the modern `Map` interface it does not
provide. Runtime code is unchanged and library type checking stays enabled.
`koffi` 3.3.4 uses its published platform binaries with build scripts disabled.

## Alternatives

**Keep Copilot limited to Herdr.** That preserved the initial Web delivery scope
and avoided claiming unverified native interaction support. It does not provide
the requested browser control path for Copilot tasks; the SDK adapter supplies
that path under the same claim and operation rules.

**Let the SDK own native process creation.** Its client lifecycle alone does not
supply the Controller's existing `onSpawn` process proof. Directly spawning the
bundled platform executable makes the native child observable, avoids the npm
launcher's synchronous wrapper, and keeps shutdown responsibility explicit.

**Observe a TUI and take control later.** This remains a different execution
model with writer handoff and transcript limitations. The existing frozen-mode
decision deliberately selects one backend before launch. The Copilot extension
reuses that choice rather than introducing a third lifecycle.

## Consequences

Copilot reuses task ownership, relay fencing, durable operations, timeline,
composer and typed interaction controls. Provider support must be advertised by
the service before a new claim is acquired. Older strict clients may reject the
new provider value, so capability discovery and compatible clients are required.

A private TCP connection requires token handling even though the runtime is
local; neither the token nor native credentials belong in browser data or task
prompts. The Controller must maintain explicit process shutdown because closing
the SDK transport does not stop the owned runtime. Binary resources and unsupported
elicitation produce visible errors instead of incomplete controls that appear
successful. Their future addition must preserve session-bound resource ownership
and typed interaction identity; it must not expose arbitrary local paths or turn
unknown input outcomes into retryable sends.

Component checks and the earlier Codex/Claude acceptance do not establish
Copilot runtime acceptance. Native steer, interaction completion, strict resume,
unknown-input handling and process cleanup require separate live evidence on
each supported platform. No cross-platform or complete Copilot acceptance claim
follows from this decision record.

Pinned SDK, CLI and declaration patches carry upgrade work. Reconsider each
patch when upstream declarations match the compiler, and revalidate native
identity, events, callbacks and stopping behavior before changing versions.
Native operation correlation would permit stronger recovery-time reconciliation
only if the provider exposes a durable caller identity with verified semantics.
