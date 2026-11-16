# Agent Note: Tag Filter Selector

Status: implemented

## Problem

Tag filtering combines search, selection and matching controls with inconsistent
presentation. Matching modes are hidden behind a second interaction, and clearing
a query and clearing active conditions need distinct, predictable effects. The
selector must preserve independent project and child scopes, selected names and
existing data-admission and dismissal behavior.

## Decision

The shared selector presents search and selectable colored tag rows before the
untagged condition and native match radios. Changes apply immediately. Separate
clear actions affect only the search query or active IDs and untagged condition;
the latter retains the query and match mode. The match radios retain their value
but are disabled with an explanation when fewer than two IDs are selected or the
untagged condition is active. The trigger counts active conditions and removable
chips retain unavailable names. Only the main filter offers tag management.

The controller and existing catalog and color owners retain state, pagination,
qualification and request lifecycles. The [toolbar decision](2026-11-14-unified-tag-filter-toolbar.md)
retains the independent filter scopes, while the [viewport decision](../architecture/2026-11-16-tag-filter-viewport.md)
owns positioning and the local event lifecycle. The
[Web design](../../../../docs/design/daynight-web.md) describes the current
implementation.

## Alternatives

**Keep a native select for matching.** It would retain the existing selection
control but require opening another menu to discover or change the two modes.

**Introduce an Apply action.** A separate draft and applied value would change
immediate feedback and add another state lifecycle to each filter.

## Consequences

Both matching options remain visible and their last value survives temporary
disablement, at the cost of fixed panel space. The catalog and panel can scroll
independently when needed. Query changes and pagination do not discard selected
IDs; ordinary reads that fail for the same query retain the displayed catalog,
while permission and identity retirement still withdraw inadmissible data.
