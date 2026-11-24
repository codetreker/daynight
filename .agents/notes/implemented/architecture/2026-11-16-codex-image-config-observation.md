# Agent Note: Codex image identity retains the new thread's declared configuration

Status: implemented

[Default image send](2026-11-24-default-session-image-send.md) changes ordinary Codex and Copilot
admission. The decision below records the original exact-qualification
policy and its evidence. Runtime observations and applicable tighter
limits still inform current capabilities.

## Problem

A model-provider name does not identify its configured endpoint. Codex reports
thread settings and a configuration resolved for a working directory, but those
reads do not provide an atomic per-thread endpoint snapshot. Substituting current
global configuration for an older thread can assign the wrong image identity.
Configuration responses can also contain credentials, and failed optional reads
must not make ordinary text input unavailable.

## Decision

The [Provider design](../../../../docs/design/session-image-providers.md) binds a
new thread to a private projection of the selected provider's explicit endpoint,
wire API and declared WebSocket capability. The digest names these visible
configuration fields, not the actual transport, destination or hidden deployment.
Headers, tokens and complete configuration never enter this projection or its
error reporting. Unknown endpoint structures and unresolved supported environment
overrides do not acquire an observation. Environment names follow the native
platform's case rules, including case-insensitive Windows names, without changing
the caller's environment.

Configuration reads use the same working directory as the actual thread-start
parameters. An explicit model is confirmed against the returned thread; it need
not equal the global default. Matching declarations before and after thread
creation establish a baseline without claiming an atomic snapshot. A later read
can restore that baseline, but cannot replace it with a different global route.
Resume remains unknown until the original thread binding has independent evidence.

The native executable digest belongs to the verified direct Windows launch
artifact and its child process. An interpreter or fallback cannot borrow that
digest. Protocol compatibility remains version- and platform-specific, separate
from the production qualification registry and its required receipt,
history, input-boundary and product evidence.

Runtime generations revoke stale asynchronous reads and image grants. Optional
reads have a bounded wait and retain at most one pending native request after
timeout. Text can invalidate an overlapping observation and continue. The final
image check runs at the transport boundary, after any asynchronous Read authority
drain. Pending native interactions prevent that write, preserving the distinction
between preparation failure and submitted input.

## Alternatives

**Use the provider alias or version string as identity.** Neither proves the
selected endpoint or executable bytes, and a custom gateway cannot borrow another
backend's image qualification.

**Treat global configuration as the resumed thread's current route.** The public
read does not establish that old thread binding. Keeping resume unknown avoids
misidentification at the cost of requiring dedicated recovery evidence.

**Follow configuration changes by replacing the running thread's baseline.** A
new global route may not be the route retained by that thread. The observation
recovers only when declarations match the original baseline; a different binding
requires native evidence or a separately created thread.

**Observe every outgoing HTTP request.** That would establish a different scope
and require a resource and forwarding contract. It is unnecessary for reporting
the explicitly limited native configuration declaration.

## Consequences

The existing exact selector can use supported observations without adding public
DTO fields or persistent schemas. Stable rereads preserve the qualification
fingerprint; model changes require their own matching qualification. Other
platforms and resumed threads remain unknown rather than inheriting local evidence.

The [qualification boundary](2026-11-16-image-qualification-boundaries.md) still
requires complete originals, exact acceptance and applicable product evidence.
Configuration visibility does not satisfy those requirements. Native acceptance
followed by failure retains originals and the original operation; it never
authorizes automatic resubmission.
