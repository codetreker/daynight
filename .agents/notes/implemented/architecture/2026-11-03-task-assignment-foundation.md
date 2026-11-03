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
and read mechanisms, native task filtering and scoped people queries.

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

Task filtering uses native UUID equality or IS NULL before pagination. Its
resolved all/unassigned/user selection participates in task cursor version 2;
project and account-Worker cursors retain version 1. Resolving me before cursor
validation makes it equivalent to the corresponding concrete UUID while keeping
another principal's self-filter out of that scope. Filters are explicit inputs,
not an execution-eligibility condition.

A project-scoped people read separates canonical profile and access facts from
Task versions. It offers complete candidate/retained-assignee enumeration and
resolution from at most 100 requested IDs. Both authenticate within one read
snapshot and use raw membership or live-task references before a LEFT JOIN to
profiles. A qualified reference without a user row is an internal integrity
failure; a request with no scoped qualification is explicitly unresolved without
revealing a global profile. Nullable names and avatars remain actual data.


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

**Advance every cursor version.** Only task scope gains the assignment selector.
Keeping project and account-Worker cursors at version 1 avoids invalidating
unrelated lists, while rejecting old task cursors keeps one unambiguous current
scope contract.

**Embed profile/access snapshots in Task.** Those facts change independently of
responsibility and task versions. A separate scoped read retains live identity
presentation without rewriting or contradicting same-version Task data.

**Enumerate all people before resolving a small set.** It would make recurring
reads depend on total project membership and historical assignments. Requested
UUIDs, native membership keys and indexed task probes keep the bounded mode tied
to the requested set; full enumeration remains an explicit catalogue operation.

**Use an INNER JOIN for profile lookup.** Missing users would silently remove
qualified references. Retaining raw candidate IDs and nullable joined user IDs
lets the service expose integrity failure instead of successful partial output.

## Consequences

Server callers receive one versioned native field and atomic permission reset.
Target eligibility shares the existing project transaction, and no new lease,
execution lock or permission role is introduced. Session and archive identities
remain governed by their own original execution context.

The native field requires every producer and complete write to carry it. Task
queries bind all resolved filter facts to their cursor; workerId-filtered task
pages use the same task cursor version and remain subsets when other filters
are present. Complete ownership inventory still requires the unrestricted
worker-only traversal.

People reads return minimal fields and explicit unresolved IDs. They neither
create membership nor change task versions, and errors never publish a partial
set. Complete catalogue cost remains a measured consideration; the bounded mode
has direct cardinality, qualification and query-plan checks. CLI/Web assignment
operations and browser cache consumption remain separate consumer capabilities.
Migration, raw-wire, snapshot, privacy, race and rollback checks retain these
boundaries.
