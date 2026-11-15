# Agent Note: Shared project Task row

Status: implemented

## Problem

Standalone Tasks, chain members and Goal members describe the same ordinary
Task, but their separate rows expose different facts, navigation and actions.
Readers cannot reliably compare identical Tasks, copy an ID, or distinguish
the available execution and Session facts across these project views. Chain and
Goal summaries also have distinct scope and disclosure responsibilities that a
shared row must not absorb.

## Decision

Project lists use a shared ordinary Task row and a list-independent, read-only
presentation model. The project adapter supplies full titles, tags, timing,
permission, platform, Worker records and admitted Session observations from
existing project data. The row does not fetch Task or list data, filter,
paginate or aggregate. Tag colors use the shared, bounded project projection
described in the [color decision](2026-11-15-web-tag-color-projection.md),
without a separate Task read for each row.
Complete-chain representatives retain their separate detail entry; scope and
ordering remain with each list owner. The [flat Goal list decision](../simplification/2026-11-13-goal-flat-list.md)
continues to own direct-member scope, and the [project Session observation decision](2026-11-15-project-session-observation-consumption.md)
owns admission, clocks and freshness. This common presentation replaces the
standalone-specific arrangement in the [container-width decision](../bug-fix/2026-11-06-standalone-row-container.md).

The Task title is a real detail link; the ID copy and available Session entry
are separate controls. Shared copy behavior preserves full values, failure and
retry feedback, and rejects results belonging to a replaced component identity.
Instance-specific associations and existing navigation owners preserve focus
and disclosure across repeated appearances of a Task. The
[Web specification](../../../../docs/spec/daynight-web.md#项目普通-task-行)
owns the visible fields and interaction contract.

## Alternatives

**Extract only the existing row markup.** The source views did not expose the
same fields or Session semantics; shared markup alone would preserve those
differences and could mistake missing data for confirmed empty facts.

**Fetch missing facts for each row.** Per-Task reads add requests and lifecycle
work, and can mix facts from different snapshots. Existing complete project sync
and admitted Session projections supply the needed inputs without row polling.

## Consequences

Equivalent Task facts now have the same presentation and actions across project
lists, while summaries, scope and navigation stay with their existing owners.
The adapter and explicit model add a mapping boundary and must preserve unknown,
failed and confirmed-empty states. Full-chain representatives remain a distinct
entry; the personal in-progress list has its own integration responsibility.
