# Agent Note: Web Task and Goal Tag Display

Status: implemented

## Problem

A shared project tag can classify a Task or Goal independently of its parent and
children. Users need to read each item's current tags in lists and details,
including after a rename or removal, without losing the existing graph context
or interaction state. Long names and multiple tags must remain readable on narrow
screens.

## Decision

The original display used a shared neutral tag list for each item's references
and a localized empty state. The [empty tag decision](../simplification/2026-11-14-hide-empty-task-tags.md)
replaces that empty state while retaining the shared nonempty display. Project
rows obtain the matching item's tags from the synchronized summary;
details use their own data or a newer summary for the same ID. Goal child rows
show the child's tags, and Goal details show the Goal's tags. Names wrap instead
of truncating. The [Web requirements](../../../../docs/spec/daynight-web.md#task-与-goal-标签展示)
and [design](../../../../docs/design/daynight-web.md#task-与-goal-标签展示)
own the display and data flow; the [cache decision](../architecture/2026-11-13-web-task-tag-cache.md)
owns versioned admission.

## Alternatives

**Bound and collapse overflow.** An accessible expansion control could limit row
height, but would add a separate interaction and state to read all tag names.
Wrapping makes the complete content available directly, at the cost of taller
rows.

## Consequences

Long or numerous tags can increase list height, while titles, status and actions
remain separately accessible. Tag changes use existing versioned synchronization
and do not alter graph nodes or edges. Editing and filtering are separate
capabilities and are not provided by this display.
