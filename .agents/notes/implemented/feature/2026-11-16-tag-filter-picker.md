# Agent Note: Tag Filter Picker

Status: implemented

## Problem

Tag-directory search, tag choices, matching and management compete within one
small panel. Browser-default search fields and buttons differ from the styled
matching selector, and two nested selection layers make a simple tag condition
harder to inspect. A narrow or keyboard-reduced viewport can also hide actions
even when the panel fits horizontally.

## Decision

The tag filter uses one coherent picker with directory search and native
checkbox rows, a separate Untagged only condition, and native radio choices for
All selected or Any selected. The matching value remains stored while disabled
when it cannot affect the result. Search clearing and filter clearing have
separate actions; filter clearing preserves the query and matching value.
Selection remains immediate, and removable colored chips keep the applied
condition visible outside the panel.

The existing controller retains catalog paging, selection qualification,
identity isolation and invalid-condition handling. A separate popover hook owns
opening focus, Escape, outside dismissal and visible-viewport positioning.
Background checks update existing content without re-running opening focus or
replacing the query controls. The panel is 352px wide where space allows and
keeps 16px visible-viewport margins. Choice-list and short-panel scrolling keep
actions reachable as the available height changes.

This replaces only the panel presentation and width in the
[unified toolbar decision](2026-11-14-unified-tag-filter-toolbar.md). Its shared
child-filter ownership and the [filtering decision](2026-11-13-web-tag-filter.md)
continue to own task matching and graph context. The
[Web design](../../../../docs/design/daynight-web.md#标签筛选选择器) describes the
current presentation and lifecycle.

## Alternatives

**Keep matching in a native dropdown.** Shared NativeSelect styling would make
its appearance consistent, but choosing between two relations would still
require a second selection layer. Radios expose both meanings in the picker.

**Add an Apply action and a draft condition.** A separate commit step would add
two versions of the filter and change the existing immediate feedback. Search,
selection and their distinct clear actions can remain directly observable.

## Consequences

The picker has one interaction hierarchy and retains current filtering and
color semantics. Viewport positioning has explicit resize, scroll and cleanup
responsibilities, and real-browser checks must cover focus continuity, keyboard
interaction and narrow geometry. A matching relation that currently has no
effect stays visible with a disabled reason. Many selected tags can add wrapped
chip rows; the anchor observes that area rather than allowing it to cover the
panel.
