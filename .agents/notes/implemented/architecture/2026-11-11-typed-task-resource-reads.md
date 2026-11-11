# Agent Note: Typed Task Resource Reads

Status: implemented

## Problem

A Task can belong to a Goal without sharing its dependency chain. Reads must
respect the container's deletion while preserving physical dependency facts for
admission and lifecycle decisions. Individual Goal reads also need progress
without storing derived counts or querying every child separately.

## Decision

A read-only PostgreSQL projection combines each Task row with its same-project
parent facts and effective deletion time. Unlocked resource reads filter that
projection before pagination or aggregation; locking operations continue to lock
physical rows. Ordinary dependency invariants use retained physical Task rows
and edges, while newly added dependency targets must be visible.

List and search select a type and optional Parent scope. Their cursors bind both;
search context identifies the actual visible parent Goal. Full Goal pages derive
progress for selected IDs in one grouped query within their read snapshot.
Summary and sync projections omit it. The [server design](../../../../docs/design/daynight-server.md)
and [search design](../../../../docs/design/daynight-task-search.md) own the
mechanisms and public contracts.

## Alternatives

**Apply parent visibility independently in each caller.** Separate joins and
conditions can disagree across pagination, direct reads and delayed details,
leaking children or excluding them after a page is already selected.

**Treat hidden dependencies as absent.** This would change readiness, reopening
and cycle decisions when a parent is deleted even though its child and edges
remain physically retained.

## Consequences

Visible reads agree on deletion without rewriting child rows or versions, and
progress is derived from the same snapshot as its Goal. The view adds a parent
join to resource reads; dependency decisions deliberately retain a separate
physical path. Independent material and Session operations use the
[resource lifecycle lock plan](2026-11-11-parent-resource-lifecycle.md) for
their physical rows. Parent mutation uses the Project write scope and validates the target Goal.
