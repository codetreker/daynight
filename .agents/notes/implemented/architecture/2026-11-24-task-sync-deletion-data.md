# Agent Note: Task Sync Deletion Data

Status: implemented

## Problem

A project consumer needs to identify every resource hidden by a deletion and
know which task update times a consistent sync covers. A deleted root alone
cannot identify descendants absent from the consumer's local topology. The
maximum timestamp of visible summaries can disappear when the last task is
deleted and therefore cannot describe all retained deletion facts.

## Decision

TaskSync returns the maximum `updated_at` among the project's physical task
rows as nullable `coverageUpdatedAt`, and an ordered `deletedTaskIds` array.
Delta IDs use the effective deletion timestamp and the existing inclusive
overlap window; an unbounded delta covers all retained effective deletions.
Snapshots return an empty array. Both reads share the authorized task snapshot,
and failures or inconsistent projections fail the entire response. A partial
expression index bounds deletion reads by project and effective deletion time;
the existing project/update index supplies coverage. Deleting a root changes
its update time and its descendants' inherited deletion time atomically.

The current Web continues to derive its watermark from visible summaries and
Task deletion still rotates the project epoch. The [sync design](../../../../docs/design/daynight-task-sync.md)
owns the protocol. This extends the historical [window API decision](../../archived/architecture/2026-10-24-task-summary-window-api.md)
without changing its project lock, snapshot or time assumptions.

## Alternatives

**Return only deleted roots.** A client may lack current hierarchy edges or may
never have fetched a descendant, so it cannot reliably retire every affected ID.

**Persist an event table or a new sequence.** The existing deletion transaction
already retains effective deletion facts. A separate event stream would add
per-write coordination, retention and recovery obligations.

**Use response time as coverage.** It could advance past a pending business
write and is not a task update time from the authorized snapshot.

## Consequences

Repeated overlap windows can return the same ID; the response carries no task
body for it. Wide windows can return many retained IDs and the transactional
index build blocks conflicting writes during migration. Physical deletion of
retained rows would require a replacement coverage mechanism or a history
replacement before it could preserve this contract. The current Web continues
its existing epoch-based deletion recovery.
