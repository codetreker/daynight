# Agent Note: Unified Tag Filter Toolbar

Status: implemented

## Problem

Project tags appear separately from the other task filters, and child tag
controls repeat inside expanded Goals. Applying one classification consistently
across multiple Goals requires repeating selections and makes filter placement
depend on the expanded cards.

## Decision

The task toolbar orders Assignee, Status and Tag filter. The ordinary Goal view
adds one Child task tag filter immediately afterward. ProjectView owns that
child condition and passes its value and invalid state to every GoalItem through
GoalList. Each row matches its own summary's tags within its direct Parent scope.
The project filter remains shared with expression search, whose result toolbar
also places it after Status; search does not use the child condition.

Child selection, query and catalog validation remain outside Goal-card and
category lifetimes. Collapse, pagination and category changes retain them.
Only the ordinary Goal view activates child catalog reads; account and project
access changes use the existing tag controller's isolation. Filtering changes
rows, while Goal identity, progress, composition, pause and Session summaries,
and dependency graph membership continue to use their complete scopes.

Panels use a readable 285px width capped by viewport space. Positioning observes
actual trigger and panel bounds when opened and when scrolling or resizing the window or neighboring filters,
so a control near the toolbar's right edge does not move its panel offscreen.
The [Web design](../../../../docs/design/daynight-web.md) owns current mechanisms.

This replaces the per-Goal child-condition ownership recorded in the
[Web tag filtering decision](2026-11-13-web-tag-filter.md). Its tag matching,
invalid-selection, search and complete-graph rationale remains applicable.

## Alternatives

**Keep independent controls and relocate them to the toolbar.** A toolbar would
need one control per Goal and an extra Goal identity choice, retaining repeated
selections while losing the original control's nearby card context.

## Consequences

One child condition consistently filters all Goal rows, including Goals opened
later or read on another page. Independently selecting different child conditions
for individual Goals is no longer available. Top-level and child conditions
remain separately readable and removable, including invalid selections.
The project owns at most one child catalog lifecycle rather than one per expanded
Goal. Shared query and selection survive presentation changes without altering
remote search or aggregate task observations.
