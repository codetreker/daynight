# Agent Note: Shared Session Display Controls

Status: implemented

## Problem

Readers need to choose between complete activity and conversation content in
Task, Test and archived Sessions without losing their current input or reading
position. An account or target change can temporarily leave a previous client
in component state. Combining that client's snapshot with the new account
would read a preference for an identity that has not been verified. A nested
display menu also needs to own its Escape behavior without closing the outer
task surface or competing with Chatbox hints.

## Decision

The shared Session View consumes the existing
[preference store](2026-11-04-session-display-preferences.md) and always supplies
an explicit mode to the [timeline](2026-11-04-session-display-reading.md).
Conversation is the product default; a valid saved choice takes precedence.
The independent selector, store and timeline originally shipped before this
integration so ordinary views kept their visible history until a control and
reading restoration were available.

Entry components retain each client's creation scope and target. They render
that client only while those identities match the current input. The shared
view binds the authenticated user to its verified snapshot's Session ID, or
uses the inert null preference when no binding is available. Mode does not
participate in the client's effect dependencies, Composer execution key or
retained entry keys.

Display uses two localized radio choices next to Refresh, with checked state
from the shared preference. Storage issues and retry stay inside the menu.
The menu coordinates Escape ownership with the Chatbox hint, restores its
trigger when dismissed by Escape and closes on outside interaction or focus
departure. Its floating layout remains accessible inside clipped or narrow
Session containers. The [Session design](../../../../docs/design/task-session-protocol.md#session-显示菜单与入口绑定)
owns the complete binding and interaction mechanisms.

## Alternatives

**Pass the latest account directly to the previous client.** Effect-driven
client replacement leaves one render in which the new account and old Session
can be combined. Checking the client's captured scope and target during render
avoids reading that unrelated preference or briefly presenting stale content.

**Let each layer handle Escape independently.** The Chatbox hint's capture
listener can consume Escape before the Display menu sees it, while unhandled
Escape can close the outer task. Coordinating the active display layer preserves
one visible dismissal target and predictable focus restoration.

## Consequences

Task, Test and readable archives share the same default, persisted choice,
localized menu and rendering behavior. Selection does not create clients,
reconnect channels, discard drafts or replay operations. The underlying
timeline still accepts omitted mode as Standard for internal compatibility;
product entry points do not rely on that fallback.

Preference failures retain the page's selection without claiming persistence.
The store's page lifetime and cross-tab/device limitations remain unchanged.
The menu adds focus and geometry obligations to browser validation, including
layered Escape, storage-error retry and desktop narrow containers. Display is
not an authorization filter and never removes stored history.
