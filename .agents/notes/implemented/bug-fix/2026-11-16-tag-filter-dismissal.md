# Agent Note: Tag Filter Dismissal

Status: implemented

## Problem

An open tag filter remains open when a user acts elsewhere, and Escape from
outside the panel does not close it. Multiple filter instances can remain open,
making keyboard ownership and focus restoration ambiguous. Dismissing a panel
must preserve its already-applied conditions and search text.

## Decision

The controlled `details` closes on an outside pointer action without consuming
the event or moving focus. Escape closes from inside or outside the panel and
returns focus to an available trigger. Prevented and composing events, native
select menus, hidden or inert triggers and active overlays retain their own
keyboard handling. A local opening notification closes other visible tag panels;
each controller retains its own query and conditions. Opening an interactive
instance focuses its search input; background checks do not refocus it. Tab
alone does not close the panel. Listeners exist only for the open instance and
are removed on closing or unmounting. The [viewport decision](../architecture/2026-11-16-tag-filter-viewport.md)
keeps this lifecycle local while adding visible viewport positioning.

The [unified toolbar decision](../feature/2026-11-14-unified-tag-filter-toolbar.md)
owns the independent project and child conditions, while the
[Web design](../../../../docs/design/daynight-web.md) owns their current lifecycle.

## Alternatives

**Handle Escape only inside the panel.** This leaves a panel open after focus
moves elsewhere and cannot provide a consistent dismissal path.

**Choose an open panel by DOM order.** Multiple mounted instances may include
hidden workspaces; DOM order does not identify the user's current panel and can
send focus to an unrelated trigger.

## Consequences

Pointer targets retain their normal actions and focus, while Escape has one
visible tag panel to dismiss. The local coordination and document listeners must
respect other overlays and be cleaned up with the component. Panel dismissal
does not alter filter conditions or submit business writes.
