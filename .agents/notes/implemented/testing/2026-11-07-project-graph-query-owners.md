# Agent Note: Project and graph query owners

Status: implemented

## Problem

Project browsing and graph tests retain background panels, task rows and dialogs.
Repeated document-wide role queries compute accessible names and visibility for
controls unrelated to the current interaction. A dispatched request also does
not establish that its cache receipt or a repeated error has reached the view.

## Decision

Project-section and task-category controls are queried within their current
named tablists. Project actions, progress navigation, filters, list pagination,
search and dialog controls use their actual owners. Graph orientation and
fullscreen actions use their toolbar; React Flow viewport controls use their
control container, and task content uses its current data-id node.

Owners are reacquired after replacement or remount. Within a stable synchronous
phase, an already found control can be reused for an assertion and interaction.
Role, accessible-name and normal visibility checks remain. Global absence,
privacy, uniqueness and total node/edge/page assertions retain their broad scope.

Pure request-count predicates use the existing short state waiter. The unchanged
refresh case also observes its current enabled action, and repeated search-error
checks observe the actual controller publication before checking presentation.
These boundaries preserve receipt and error identity instead of depending on
sampling delay. The real cache, controller, storage and graph renderer remain.

All pagination datasets, the full 101-task expansion sequence, complete forward
and reverse keyboard cycles, viewport and focus assertions remain. Production
expansion calculation is assessed independently; query scoping changes no graph
algorithm or animation default. The [Web validation guide](../../../../packages/daynight-web/README.md#development)
owns the commands and gates; the [Step-query decision](2026-11-05-step-panel-query-owners.md)
records the corresponding row/form ownership rule for a different test owner.

## Alternatives

**Retain document-wide discovery.** Its implicit scope does not identify the
control owner and repeats unrelated accessible-name work. Global queries remain
where their wider uniqueness or absence result is the actual proof.

**Use text-only or hidden queries.** These would bypass role/name or visibility
requirements and could select retained inactive controls.

**Reduce datasets, unmount background panels or shorten keyboard cycles.** Those
mechanisms carry pagination, retention and focus proof; query discovery can be
changed without replacing them.

**Change graph computation together with test queries.** Algorithm changes have
their own ordering and induced-edge invariants. Separating their measured effect
keeps the query proof reviewable and avoids attributing unrelated savings.

## Consequences

Tests describe the owner of an interaction while preserving their observable
proof. Scoped uniqueness is narrower than document uniqueness, so the required
whole-view checks remain explicit. Callback, render and allocation costs still
need measurement; one passing run or a local file gain does not establish a
whole-Job improvement. New view owners must retain connectedness, current
presentation and remount boundaries when extending these helpers.
