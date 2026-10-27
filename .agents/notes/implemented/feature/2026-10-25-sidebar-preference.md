# Agent Note: Local Sidebar Preference and Temporary Navigation

Status: implemented

## Problem

A permanently expanded workspace sidebar consumes reading space. Users need to
recover their chosen width when reopening the browser or moving between
projects. Narrow screens also need reachable navigation without allocating a
full navigation column, while authentication recovery, graph viewing and task
details retain their existing interaction and state ownership.

## Decision

`WorkspaceSidebar` owns navigation presentation, with project navigation in its
scrollable main region and the account destination and toggle in the footer.
The [bottom account navigation decision](2026-10-25-bottom-account-navigation.md)
owns that placement. Desktop expanded and folded widths are 190px and 68px.
Main entries keep icons, accessible names and hover titles when their text is hidden.
Nested project links are hidden in the folded rail; the
[project navigation decision](2026-10-27-sidebar-project-navigation.md) owns their
shared directory and selection.

Workspace owns `useSidebarPreference`, which stores only JSON boolean under
`daynight.web.sidebar.collapsed` in origin-local storage. No record means
expanded without an initial write. Read failures, invalid contents and failed
writes retain their original cause internally and appear as localized feedback
below the topbar. Explicit switches retain their in-memory result even if saving
fails. Retry saves the current result; success clears the current issue. The
appearance value contains no user or project identity and survives account and
project changes. It does not reuse project-private preference helpers.

At 740px and below, a 60px rail opens a 220px overlay. JavaScript's
`SIDEBAR_NARROW_QUERY` and CSS share that explicit breakpoint convention.
`drawerOpen` is temporary and separate from the stored desktop `collapsed`
value. The overlay stays inside the Workspace identity barrier, uses modal
semantics and focus containment, preserves the workspace's prior inert state,
and shares the reference-counted body scroll lock. Closing releases only its own
isolation and lock. Escape and backdrop dismissal restore the opener; route
navigation uses the existing content focus policy. Route changes, returning to
desktop, identity verification or blocking recovery, and unmount end the
temporary layer.

Normal [foreground identity checking](../bug-fix/2026-10-23-silent-foreground-identity-checks.md)
remains distinct from blocking recovery. The checking signal closes the temporary drawer without making normal checking
hide or disable the content. The native recovery dialog remains able to take
focus. Sidebar width and temporary state do not participate in user, project,
cache or detail keys, and do not create another request or synchronization loop.
The graph keeps its existing resize observation and viewport ownership.

The [Web requirements](../../../../docs/spec/daynight-web.md#工作空间导航)
and [design](../../../../docs/design/daynight-web.md#工作空间导航) own visible behavior
and current mechanisms.

## Alternatives

**Store the choice on the server or account.** That adds a write API and
cross-device semantics to a browser appearance preference. A single local
boolean satisfies reopening and project navigation without mixing this state
with authentication or business data.

**Use one boolean for desktop folding and the narrow-screen drawer.** Opening
navigation on a phone would overwrite the desktop choice, so moving across the
breakpoint could restore an unintended width. Separating temporary interaction
from appearance persistence prevents that coupling.

**Add cross-tab or server synchronization.** Other tabs observe the saved choice
when their workspace next initializes; they do not receive live updates. Live
updates can be added around the dedicated boolean record without changing the
mobile state model. Server synchronization would require separately defining
account and device precedence. Neither is required for the local persistence
behavior.

## Consequences

The browser recovers its desktop appearance while phone navigation remains a
reversible interaction. Storage failures remain actionable and do not claim a
successful save. Keeping the drawer inside the identity barrier and sharing the
scroll lock makes navigation cleanup compose with task detail and graph modes.
Preserving component keys avoids rebuilding the active project or resetting its
graph viewport when navigation changes width.

The application adds only browser storage and local media-query and interaction
listeners. Workspace disposal releases their lifetime. The key is origin-local,
so another browser or origin has its own choice, and a tab already open retains
its in-memory choice until a later explicit switch or workspace initialization.
