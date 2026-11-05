# Agent Note: Server Task Boundaries

Status: implemented

## Problem

Task lifecycle, claims and owned resources combine authorization, domain rules
and database transactions. Concrete store callbacks conceal completion outcomes
and make changes to Task state and dependent Session fences easy to separate.
Thread writes have a different lock order from Project writes.

## Decision

`core/task` owns Task, claim, Steps, Thread and projection rules. `service/task`
selects snapshots and write scopes, combines Project admission with Task and
Session effects, and interprets completion. `server/task` adapts Task HTTP
resources. The [Task data decision](2026-11-05-task-data-ownership.md) owns the
shared property and encoding definitions.

Task changes, Session freezing and cache invalidation share the Project write
transaction. `core/session` selects the claim fence and draining transition. Thread
writes use a dedicated scope that locks Task, credential, authorization and head
in that order without prelocking Project. The database clock supplies message
positions; an unconfirmed commit remains unknown.

## Alternatives

**Keep Task orchestration in concrete store methods.** Hidden Session effects
would make the atomic combination and completion outcome difficult for callers
to inspect or reuse.

**Use Project writes for Thread messages.** Prelocking Project changes the
existing lock order and serializes unrelated messages and Project writes.

## Consequences

Transaction-bound capabilities remain valid only inside their callback. Domain
refusals cannot mask completion failures. Thread messages preserve the Task
version and do not wake Workers. SQL stays in the existing store implementation
until its separately owned physical migration.
