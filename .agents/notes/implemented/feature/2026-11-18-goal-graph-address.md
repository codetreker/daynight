# Agent Note: Goal Graph Address

Status: implemented

## Problem

A Goal's complete dependency graph can include disconnected work or no Tasks.
Its project reading history cannot be shared or restored after authentication
or a page reload, and an ordinary chain anchor cannot identify that graph.

## Decision

The project tasks URL accepts a Goal ID in `goalGraph`. The current complete,
authorized project snapshot admits the Goal before the existing graph reader
opens. The address and reading selection commit together through navigation;
the parameter remains until the graph is closed or its binding is retired.
The [Goal requirements](../../../../docs/spec/daynight-goals.md#goal-整体依赖图)
and [inspection design](../../../../docs/design/daynight-task-inspection.md#goal-整体图)
own the behavior and admission mechanism. This extends the
[project tab URL decision](2026-11-17-project-tab-urls.md) and complements
[ordinary chain sharing](2026-11-18-task-chain-sharing.md).

## Alternatives

**Consume the address once like an ordinary chain.** A reload would lose the
Goal graph even though the Goal has its own stable identity.

**Use a separate page or a member Task as the anchor.** A separate page would
duplicate the graph reader and its navigation; a member cannot represent an
empty Goal and can belong to a different ordinary component.

## Consequences

The address survives login and reload without serializing graph content, drafts
or authority. Opening waits for current project admission, and invalid or
revoked targets cannot be restored from cached presentation alone. History and
the retained address must remain synchronized when the reader changes or closes.
