# Agent Note: Task Chain Sharing

Status: implemented

## Problem

An ordinary dependency chain has no persistent identifier. Its graph can be
opened from a project or a Goal, but its local reading history cannot be shared
or carried through authentication to another browser tab.

## Decision

The graph menu copies a same-origin project tasks URL with a readable ordinary
member as its `chain` anchor. The project graph retains its opening witness;
Goal graphs choose and retain a valid member belonging to that Goal. The project
owner resolves the anchor against the current complete readable index and uses
the existing navigation and draft admission. It consumes the query in the same
history transaction as the resulting reading selection. The
[requirements](../../../../docs/spec/daynight-web.md) and
[design](../../../../docs/design/daynight-task-inspection.md) own the behavior.

This extends [project tab URLs](2026-11-17-project-tab-urls.md) with an explicit
chain entry while retaining local history for other nested reading choices.

## Alternatives

**Use the existing chain fragment.** Login return paths intentionally omit
fragments, so this would lose the destination across authentication or require
widening the established redirect policy.

**Store a graph snapshot or assign a chain ID.** Both require new persistence
and could describe stale or inaccessible membership. A readable member instead
resolves to its current ordinary component under existing access rules.

## Consequences

The link follows later changes to the anchor's component and does not preserve
its former membership or view. Removing access to the anchor makes the target
unavailable even if another former member remains readable. No server change or
new permission is needed; query consumption must preserve history and draft
admission and cannot replay an accompanying fragment.
