# Agent Note: Shared Task-list Scroll Position

Status: implemented

## Problem

Switching between Standalone tasks and Task chains restores a different saved
absolute document offset. A category change can therefore move the page away
from the controls just used. Returning to a chain list also resets its row-local
disclosure, so an offset saved while expanded can exceed the collapsed page's
height. Category history does not provide a stable position for this shared
project page.

## Decision

Both task categories share one task-list document offset per project.
`useTaskListScroll(projectId, active)` owns that offset and registers scroll and
pagehide listeners only while the project snapshot is available and Task list
is selected. Category selection is not an input to restoration. Switching inner
categories leaves the current document position alone; a shorter document can
naturally clamp it to its maximum offset. Returning to longer content does not
restore a category's older position.

The shared offset is a nonnegative finite JSON number at
`daynight:task-list-scroll:${projectId}`, initially zero. The old
`daynight:task-view-scroll:${projectId}` object is no longer read, converted or
written. Read, validation and write failures retain the existing localized
preference notices and usable in-memory interaction. Leaving Task list saves
its current offset before Overview restores its separate per-mount position.
Task-list entry, reload and project return restore the shared offset after the
content becomes visible. Explicit pagination and Overview progress navigation
still position and focus their target after restoration; Overview navigation also
highlights it.

This supersedes only the independent category-offset choice in the
[task views decision](../feature/2026-10-22-project-task-views.md) and updates the
scroll record retained by the [project sections decision](../feature/2026-10-25-project-overview-task-sections.md)
and [section restoration decision](2026-10-25-project-section-restoration.md).
Those decisions originally preserved each list's reading position across
category visits. The separate Overview position, per-project section/category
choices and conditional category mounting remain. The [status filter decision](../../implemented/feature/2026-11-05-task-list-status-filter.md)
replaces the independent Show all choices with shared list conditions.
The [Web specification](../../../../docs/spec/daynight-web.md) owns observable
behavior and the [Web design](../../../../docs/design/daynight-web.md) owns the
current composition and stored formats.

## Alternatives

**Keep separate category offsets.** This resumes a category's previous location,
but every switch can jump away from the current page position and an offset can
outlive the expanded content that made it meaningful. One shared offset follows
the user's current position while keeping restoration when leaving the task
workspace.

## Consequences

Inner category switching causes no application scroll restoration or new storage
format conversion. The first visit without the shared record starts at zero;
old category offsets are intentionally ignored. Browser range limits still apply
when content shrinks, and inactive category rows continue to unmount. Overview
and task-list scrolling remain isolated, and explicit navigation retains its
existing priority. Regression coverage must distinguish category switches from
section entry and verify real document clamping as well as saved-value decoding.
