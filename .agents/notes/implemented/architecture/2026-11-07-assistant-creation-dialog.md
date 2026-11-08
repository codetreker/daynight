# Agent Note: Compact assistant creation with Worker-bound choices

Status: implemented

## Problem

Assistant creation normally requires only a name, but optional remote directories,
models and reasoning effort need more room than the list can spare. Expanding
those controls in the inventory reduces the visible assistants and competes with
conversation navigation. Configuration also belongs to a particular Worker and
Provider: a value read from one machine must not silently apply to another, and a
native catalog alone cannot explain the user's successful preferences.

## Decision

A compact native modal contains the name-first form and an optional directory
view. The [management design](../../../../docs/design/bot-management-web.md) owns
its composition and the [management specification](../../../../docs/spec/bot-management-web.md)
owns observable behavior. This partially supersedes the inline creation placement
in the [conversation-first presentation decision](2026-11-05-assistant-management-presentation.md).
That earlier choice kept a short name form within the workspace and avoided
interrupting conversation interaction. Directory browsing and model controls make
the list-height cost material; the dialog keeps those controls reachable without
resizing the list or replacing the existing Session host.

The form stores explicit choices separately from effective values. Bot defaults
resolve successful preferences and configuration sources. Native model discovery
supplies the bounded catalog, including hidden models, and per-model reasoning
capability. Its successful default observation fills a native/null delegation
without replacing an explicit choice or a value already resolved by Bot defaults.
The effort fallback must belong to the same effective model, including its
aliases. Hidden models participate in capability matching but stay out of new
model choices; a previously explicit hidden value remains available for reset.
Browsing and reading a menu leave the request implicit, and choosing only effort
never promotes an observed model into an explicit override. Confirming a directory or selecting a machine-dependent option pins the
resolved Worker. Worker, Provider and model changes clear the appropriate
subordinate form overrides and trigger fresh resolution. Current explicit Worker
configuration errors remain visible.

Directory navigation uses the remote Worker's returned paths in the same modal.
Cancellation returns to the retained form, restores Browse focus and never
applies the candidate path. Read cancellation, account scope and request
generations reject stale results; pagination additionally retains connection and
catalog identity. Unknown or unsupported capability has no invented options.

The dialog follows visualViewport height and vertical offset, with a window
fallback. Fixed header and action regions surround a scrollable body. Native
modality owns background isolation, while the active view handles Escape and
focus restoration. The existing Session binding, client, draft and reading
position remain independently owned. The
[creation identity decision](2026-11-05-bot-management-web.md) still owns retaining
the original ID before dispatch and observing unknown outcomes without replay.

## Alternatives

**Keep inline creation with expanded settings.** This preserves the earlier
workspace interaction benefit, but the longer form and directory list consume
inventory height, especially in short viewports. It also makes optional settings
compete with assistant selection.

**Nest a directory dialog inside the creation dialog.** A second modal would
require another focus, dismissal and scroll-lock boundary for one temporary
selection. Switching the existing dialog's content preserves the form state and
gives Escape one unambiguous return target.

**Submit every displayed default.** This would convert observation into explicit
preferences and could bind a previously automatic request to stale preview
values. The form submits only explicit choices and leaves resolution with the
server. The model catalog remains a capability source, not a second preference
resolver.

**Require a model selection before choosing effort.** Native delegation is a valid
model choice. Requiring an explicit model would change the request and its future
successful preference merely to expose a supported effort control. A successful
catalog observation supplies that control without altering the request.

## Consequences

Creation temporarily isolates the workspace, but its expansion no longer consumes
list height or changes conversation geometry. The compact default view leaves
full paths and sources one keyboard-accessible expansion away. Additional form
state and cancellation rules are necessary because each directory or catalog
belongs to a specific target and observation generation.

Changing a model can expose an incompatible Worker effort; this is a real
configuration error rather than permission to silently choose another effort.
Directory success is an observation, not a reservation or guarantee of later
startup access. Defaults and catalog reads can fail independently, and retries
must preserve the user's draft without merging observations from different
targets.

Component and API checks cannot establish native dialog geometry or focus
behavior. Browser measurements are needed for desktop, narrow and short
viewports, long content and IME interaction. Controlled browser responses prove
frontend consumption only; real Worker/Provider startup, successful-preference
persistence and physical phone keyboards require separate evidence. A lost
creation response remains unknown after closing the dialog, including when a
subsequent read returns 404.
