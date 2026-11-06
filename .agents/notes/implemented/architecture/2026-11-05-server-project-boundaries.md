# Agent Note: Server Project Boundaries

Status: implemented

## Problem

Project ownership, access, grants and invitations share database facts with Task
writes. Concrete transaction callbacks couple those rules and their callers to
PostgreSQL, while creating a Project and writing an existing Project require
different locks. Transaction failures must remain distinguishable from business
refusals.

## Decision

`core/project` owns Project validation, authorization, ownership and membership
rules. `service/project` selects creation, existing Project write and snapshot
scopes and handles completion; `server/project` owns HTTP adaptation and reusable
Project projections. Existing Task writes use the same Project write scope and
its transaction-bound Project, Task and Session capabilities.

Creation locks the user and Team before atomically inserting the Project,
ownership and creator's admin grant. Existing writes lock the Project before the
callback reads current facts. Transfer retains Project, ownership, then ordered
Team locks. The [Team creation decision](2026-11-04-team-project-creation.md) and
[transfer decision](2026-11-04-project-transfer.md) retain their concurrency
rationale. `ProjectScope` remains a query value for scoped project pagination.

## Alternatives

**Use the existing Project writer for creation.** A new Project row does not
exist to lock, and that path would lose the user and Team admission locks.

**Keep concrete Project transactions in callers.** This preserves the former
call shape but couples domain rules and Task consumers to the PostgreSQL
implementation and obscures their shared transaction lifetime.

## Consequences

The scope capabilities cannot outlive their callback. Completion and cleanup
failures take precedence over staged refusals, and uncertain commits remain
unknown. The [Task boundary](2026-11-05-server-task-boundaries.md) owns Task business
rules; the [PostgreSQL backend](2026-11-05-server-postgres-ownership.md) owns
their database implementations. Task and Session
effects continue to share the Project transaction.
