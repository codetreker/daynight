# Agent Note: Task Step positioning in the detail session

Status: implemented

## Problem

A Task can contain more Steps than the detail view mounts at once. Position
changes must use the complete service order while preserving the moved Step's
identity, expansion and focus. Task and Step writes share a version, and a
lost or invalid receipt cannot establish where the Step ended up.

## Decision

The detail session's [shared write owner](2026-11-04-task-steps-web-status.md)
submits position changes and validates the complete returned order, unchanged
Step fields and timestamps, and the appropriate changed or no-op version. Its
existing identity, generation, mutual exclusion and reconciliation rules apply
to position writes as well as status writes. A missing target or anchor and
invalid self-reference remain explicit refusals.

The list computes adjacent placements from the complete in-memory resource. A
reusable local target picker filters names and IDs across that resource, mounts
at most 100 candidates, and retains selection by ID across filters and numeric
pages. A confirmed move locates the moved ID in the returned collection and
restores its page and focus; expansion remains keyed by ID. Content forms and
insertion can reuse the picker without owning a second Steps resource.

## Alternatives

**Choose only among visible rows.** This would make a valid cross-page placement
inaccessible and incorrectly equate the rendered page with the service order.

**Use an unbounded native selection list.** This would mount an option for
every Step and make large legal collections expensive to render and navigate.

## Consequences

Filtering scans the in-memory collection and does not add a service query. The
bounded DOM limits mounted controls but does not reduce collection transfer or
memory. [Content editing](2026-11-04-task-steps-web-add.md) shares the form and
write owner; insertion and deletion remain separate capabilities.
