# Agent Note: Size Bot Panels from Available Workspace Width

Status: implemented

## Problem

A viewport breakpoint cannot account for the Workspace navigation and content
padding. At a 768px viewport with navigation expanded, the 280px assistant list
and 24px gap left only 238px for the conversation, even though smaller viewports
already showed a single panel.

## Decision

The Bot workspace is a named inline-size container with a flex row. Below 724px
of available content width, CSS hides the list when a Bot is selected and hides
the conversation otherwise. At and above that width, the list occupies 280px
and the 24px gap leaves at least 420px for the conversation. The existing route,
SessionHost and cache remain responsible for selection and state retention.

The [management design](../../../../docs/design/bot-management-web.md) owns the
layout mechanism. The [Session cache decision](../architecture/2026-11-04-bot-session-cache.md)
continues to own identity and retention rules.

## Alternatives

**A larger viewport breakpoint.** It would correct one navigation state but fail
to account for the space recovered by collapsing the sidebar or embedding the
workspace at a different width.

**An extra container around the existing grid.** This would allow the grid to
query an ancestor, but adds a layout wrapper to the height chain. A flex row can
keep the existing DOM while its children query the workspace directly.

**JavaScript width state.** Measuring width and rendering alternate hosts would
add lifecycle coordination to a presentation rule. CSS can change panel
visibility without changing the selected binding or restarting a Session.

## Consequences

Tablet conversations reclaim the list's space automatically. Search and loaded
list content remain mounted; returning through the existing route keeps the
cache's normal draft and reading behavior. Browser regression tests measure
available width, panel visibility and input geometry, with separate assertions
for retained DOM and Session commands.

The budget defines when two panels fit; it does not redesign title wrapping,
the Session toolbar, or the existing details drawer breakpoint. Those controls
retain their own responsive behavior. Controlled browser transports establish
frontend retention only; native Provider lifecycle requires separate evidence.
