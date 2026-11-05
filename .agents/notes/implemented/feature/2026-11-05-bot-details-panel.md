# Agent Note: Bot details within the Session fullscreen boundary

Status: implemented

## Problem

Readers need to inspect an assistant's environment without losing their current
conversation or reading position. The selected name, configuration and writable
Session must belong to the same Bot, including while a new selection is loading.
A narrow details drawer also needs to coexist with Session fullscreen: two
independent focus owners can otherwise make the drawer inaccessible or dismiss
both layers with one Escape.

## Decision

The [management page](../../../../docs/design/bot-management-web.md) keeps details
visibility outside Session cache and client identity. The name button opens a
panel beside the existing conversation subtree. Both consume the same selected
Bot read; changing that resource clears the previous details while retaining the
open intent. The panel displays only name, observed status, Worker, frozen cwd
and Agent. Startup success remains distinct from current availability.

The same dialog element participates in the desktop layout as a nonmodal
complementary region and uses native `showModal()` at widths up to 1000px. Native
modality and top-layer behavior isolate the drawer; its local Tab edge handling
keeps focus inside even when the close button is the only control. The counted body
scroll lock prevents background scrolling. Explicit close restores the current
name button when it remains connected and available. Crossing the breakpoint
closes the old dialog mode before entering the new one.

The [shared fullscreen hook](2026-11-04-session-fullscreen.md) accepts an optional
ancestor boundary through `BotSessionHost` and `SessionView`. The Bot conversation
boundary includes its title, original Session subtree and details. Fullscreen
registration, isolation, viewport variables and focus use that root without
moving or remounting the Session. The default Task/Test root remains its Session
section. A supplied root must contain that section.

For an outer boundary, keyboard handling occurs at document bubble time, after
React handlers inside the boundary. Details consumes Escape and cycles its own Tab edges
before fullscreen can act. This preserves one dismissal per key and prevents an
outer focus loop from selecting controls outside the native modal. Closing or
unmounting each owner releases its own locks and restores its previous attribute
and style values. Layout changes continue through the shared timeline's reading
anchor mechanism.

## Alternatives

**Add a sibling drawer without changing the fullscreen root.** The original
Session root makes its sibling inert and redirects its focus into the Session.
A native dialog alone does not resolve that application-level focus ownership.
Including the existing conversation ancestor keeps both controls reachable.

**Move or duplicate the Session when details or fullscreen opens.** A new
container or subtree risks replacing DOM, clients and reading state. The panel
is instead a sibling within a stable composition, and only geometry changes.

**Implement independent document focus and inert ownership for the drawer.**
Another document-level owner would need to arbitrate focus redirects and
background state with fullscreen. Native modality owns background isolation;
local Tab edges and event propagation keep keyboard handling within the drawer.

## Consequences

Details can open in fullscreen without changing connection identity, drafts or
timeline ownership. The outer boundary is an opt-in composition contract, so
future floating controls must be descendants of that boundary or define their
own interaction with isolation. Tests need real browser geometry, native dialog
focus, DOM identity and reading anchors; DOM emulation alone cannot establish
these results.

Webhook and MCP configuration remain absent. Keeping details separate from
Session runtime identity allows later informational or settings content without
changing how the Bot is hosted. Navigation advertisement and complete native
Worker/Provider acceptance remain separate from this presentation capability.
