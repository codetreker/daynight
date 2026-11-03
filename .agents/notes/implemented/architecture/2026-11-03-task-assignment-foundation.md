# Agent Note: Task assignment foundation

Status: implemented

## Problem

A worker claim records one execution, while a task also needs an optional human
responsible for its outcome. Responsibility changes must revoke automatic
selection without transferring execution authority, and ordinary writes must
retain that responsibility after a person leaves the project.

## Decision

The [assignment contract](../../../../docs/spec/daynight-task-assignment.md) uses
a native nullable tasks.assigned_to UUID column and an explicit nullable
assignedTo field on full Task, task-sync and graph responses. Ordinary task
creation and PATCH own setting and clearing it; it is not a property definition.
The [design](../../../../docs/design/daynight-task-assignment.md) owns the write
and read mechanisms.

A neutral currentTaskWrite constructor preserves assignment through metadata,
status, property and worker writes. Input normalization precedes candidate
comparison. Actual assignment changes run a shared transaction policy after
no-op/deletion handling, reject in-progress work, validate a new target and set
AllowAgents false in the same update. Equal values preserve permission and do
not revalidate a retained former assignee.

Migration 028 adds the column and project/assignment/keyset index. Historical
and soft-deleted tasks receive NULL without rewriting versions, business times,
properties or execution identities. The model never persisted Task creator
identity, so migration does not attribute responsibility from an administrator,
worker or other inferred identity.

## Alternatives

**Register a string property.** It would reuse the generic property commands and
storage, but assignment is first-class task metadata. A native UUID provides its
identity type and index directly, and ordinary Task PATCH returns the complete
assignment/permission result without a property-receipt split.

**Create an assignment or audit relation.** It could support multiple people and
assignment history, neither of which belongs to the single optional assignee
contract. Independent relation identity and version coordination would add a
second mutation model.

**Keep separate complete-copy constructors.** Worker and metadata constructors
would each need future field updates. One neutral constructor makes retention
an explicit shared responsibility and prevents unrelated lifecycle writes from
clearing the native column.

**Backfill an inferred historical owner.** Neither execution ownership nor a
project role establishes who created or is responsible for a historical task.
NULL retains the actual absence of that fact.

## Consequences

Server callers receive one versioned native field and atomic permission reset.
Target eligibility shares the existing project transaction, and no new lease,
execution lock or permission role is introduced. Session and archive identities
remain governed by their own original execution context.

The native field requires every producer and complete write to carry it.
CLI/Web assignment operations and new browser cache consumption remain separate
consumer capabilities. Those consumers are not implemented by the field
producer.
User profile and access display are independent facts and do not enter Task
versions. Meaningful migration, raw-wire, race and rollback checks retain these
boundaries.
