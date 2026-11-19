# Agent Note: Project Settings Navigation Visibility

Status: implemented

## Problem

The selected project settings link can leave the visible navigation area when a
desktop window narrows or translated labels change width. The selected section
remains correct, but users cannot identify their current position. Repositioning
on every background render would interrupt deliberate manual navigation scrolling.

## Decision

Project settings retain the existing responsive navigation and stable links.
One measurement function reveals the selected link after selection, language or
state-label changes, and after ResizeObserver reports container or link size
changes. All links are observed because an earlier link can move the selected
one without resizing it. The function changes only the navigation's horizontal
scroll position and only by the necessary distance. Oversized links align their
beginning while remaining manually scrollable. The
[design](../../../../docs/design/project-settings.md) owns geometry and lifecycle
details; the [workspace decision](../architecture/2026-11-13-project-settings-workspace.md)
owns section identity and retained editing state.

## Alternatives

**Keep selection-only positioning.** It handles initial direct links and section
changes, but neither viewport narrowing nor translation changes selection.

**Listen only to window resize.** It misses container changes and link growth
from translated labels or state summaries.

**Reveal on every render.** Unchanged background reads can create new state
objects and would pull users back after they manually scroll to other links.

## Consequences

The current section stays identifiable across layout and content changes without
rebuilding links or affecting drafts, focus, routes or body scrolling. Observing
five links adds a bounded observer lifetime, disconnected at unmount. Widths
smaller than a complete label cannot display both ends at once; start alignment
and unrestricted manual scrolling preserve access to the full label.
