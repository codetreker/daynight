# Agent Note: Project Tag Storage

Status: implemented

## Problem

Tasks and Goals need project-local classification with stable identities, independent associations, and names that can change without rewriting every association. Catalog reads, conditional writes, and deletion must share the existing project transaction and snapshot guarantees.

## Decision

PostgreSQL stores catalog entries in `project_tags` and associations in `task_tags`. A project and C-collated name key have a unique index; association and reverse indexes support both directions. The project write scope binds the tag and association DAOs to its locked transaction, while the read scope binds the catalog reader to its repeatable snapshot. A separate catalog epoch can rotate without changing project metadata or the task cache epoch. Usage counts filter effective deletion; explicit association cleanup includes retained deleted entries. Association touch changes only task version and update time.

## Alternatives

**Task properties.** The fixed property registry does not provide catalog identity, project-wide uniqueness, or indexed reverse associations. Copying names into properties would also require rewriting each association on rename.

**Names in association rows.** Duplicating names would require synchronizing every copy and make the stable tag identity and current name easier to diverge.

## Consequences

The database enforces project-local name and association uniqueness, while business consumers remain responsible for name validation, authorization, version decisions, and coordinating catalog and association changes under the project lock. Historical tasks have empty associations without a fallback. Touching associated tasks on rename or deletion is a set update; its cost grows with the number of associations. The storage design is described in the [server architecture](../../../../docs/design/daynight-server.md#领域模型与存储结构).
