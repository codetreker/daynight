# Agent Note: Task Assignment Index for Effective Visibility

Status: implemented

## Problem

Task assignment lists and bounded assignee resolution need to locate rows by
project and assignee. Their effective deletion filter also considers a parent
Goal, so it is expressed through `task_resource_rows`. PostgreSQL cannot rely
on the existing index's `deleted_at IS NULL` predicate from that view filter
alone. The original assignment index and its rationale are recorded in the
[assignment foundation](../../archived/architecture/2026-11-03-task-assignment-foundation.md).

## Decision

A full B-tree index on `(project_id, assigned_to, created_at, id)` provides a
candidate access path for assignment-filtered lists and assignee probes through
`task_resource_rows`. The original partial index remains available to other
queries. The query still applies `effective_deleted_at IS NULL`: an index entry
alone does not establish that the Task or its parent is visible. Migration 063
adds the index to existing databases and the schema snapshot includes it for new
ones.

## Alternatives

**Add an explicit physical deletion predicate to the queries.** This may let
PostgreSQL use the existing partial index without maintaining another index. It
would require changing each relevant query and verifying the effective parent
visibility rule; the selected full index leaves those query contracts intact.

**Replace the partial index.** Removing it would alter access paths for existing
physical-row queries. Keeping it avoids assuming the full index is equally useful
for every workload without measuring those consumers.

## Consequences

The full index includes deleted rows and adds storage and maintenance on Task
writes. Its transactional build blocks Task writes until the migration completes;
build time depends on table size. PostgreSQL may choose a different plan for a
different distribution, and retained deleted rows can increase filtering work.
The bounded PostgreSQL sample observes query plans but does not establish a
production latency or capacity guarantee.
