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
AllowAgents false in the same update. Equal assignment causes no permission
reset and does not revalidate a retained former assignee; other supplied fields
retain their ordinary mutation rules.

New target eligibility consumes ProjectAccess in that project transaction.
The canonical projectAccessRelation in store/project_access.go also owns the
access candidates and hasProjectAccess calculation for both people-read modes.
It currently represents real direct authorization only, with one effective role
per project/user and raw identities retained independently of profile presence.

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
originally independent of execution eligibility. That initial separation kept
human responsibility distinct from execution ownership. The [self-assigned
acquisition decision](2026-11-03-worker-self-assigned-claims.md) now requires
assignment to the authenticated user for automatic candidates and claims, while
retaining original claim authority for inventory and manual control.

A project-scoped people read separates canonical profile and access facts from
Task versions. It offers complete candidate/retained-assignee enumeration and
resolution from at most 100 requested IDs. Both authenticate within one read
snapshot and use raw access or live-task references before a LEFT JOIN to
profiles. A qualified reference without a user row is an internal integrity
failure; a request with no scoped qualification is explicitly unresolved without
revealing a global profile. Nullable names and avatars remain actual data.
Bounded resolution probes only requested identities; an unrequested missing
profile cannot fail that read, while complete enumeration still exposes it.

Web Task/detail/summary/graph consumers require the nullable field, and schema 4
rebuilds old task material from versions 1, 2 and 3. The detail session owns one
normal Task PATCH and read-only reconciliation of unknown outcomes. It predicts
same-value versions separately and preserves assignment across all other
mutations.

A scope-owned, session-memory people owner coalesces rendered/detail/filter ID
demands and successful mount-local receipts. Batches contain at most 100 IDs;
empty demand sends no request, and full catalogues are opened explicitly. Each
person has an accepted dispatch sequence, while project/user fences protect
history and authorization. A trusted parent-project denial is processed even
when presentation demand changes, without letting an old history revoke a new
one.

The Web keeps status and assignee in one compact control group and matches
assignees only in displayed list selections. Full chain progress, dependencies,
readiness and overview facts retain the complete index. Mutable profile data
never enters Task versions or persistent task records.

The CLI requires nullable assignedTo on every Task and graph input, preserves it
in JSON and shows its current UUID or unassigned in text. Ordinary create/update
flags own assignment and null clearing; the
[CLI creation default](../process/2026-11-04-cli-create-default-assignee.md)
uses the authenticated account when creation omits its assignee, while direct API
creation retains optional assignment. List alone accepts UUID/me/unassigned filters. Ready has no assignee command option. Automatic worker candidates use
me, while complete existing-claim inventory remains unfiltered by responsibility;
the [self-assigned acquisition decision](2026-11-03-worker-self-assigned-claims.md)
owns that runtime rule.

For me filtering, successful task-page parsing receives that response's
principal header. A complete traversal binds its first successful identity and
checks every page, even an empty one, without an extra identity request. The
binding belongs to one traversal; normal non-me requests retain their existing
optional-header behavior when no expected principal is configured. Ordinary
Task PATCH returns the complete mutation result, so the CLI adds no normal
post-write GET or profile lookup.

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

**Keep assignment eligibility and directory access in private direct queries.**
Their current results agree with resource admission, but separate SQL owners
would require coordinated policy changes in every caller. Reusing the canonical
actor/batch access source preserves the distinct profile and retention rules
without duplicating authorization semantics.

**Use an INNER JOIN for profile lookup.** Missing users would silently remove
qualified references. Retaining raw candidate IDs and nullable joined user IDs
lets the service expose integrity failure instead of successful partial output.

**Filter task-sync or rebuild the graph from matches.** Hidden prerequisites
would disappear from readiness and progress. Matching displayed rows before
pagination retains navigation context without changing authoritative graph
facts.

**Publish directory results only against the latest visible demand.** That
would drop an already observed project denial when a menu closes or a person
set changes. Scope/ticket-bound negative admission remains distinct from
positive profile publication.

**Store only a largest receipt revision.** Re-mounted graph owners start their
local counter again. Owner identity plus revision preserves successful-refresh
semantics without a false global sequence.

**Infer me from a task or cached client identity.** An empty page has no task
from which to infer it, and an unconfigured client has no expected principal.
Per-response metadata validates the actual successful response and detects
later-page account changes without adding a separate /me round trip or global
identity state.

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
has direct cardinality, qualification and query-plan checks. CLI assignment
operations use required nullable parsing, direct mutation and principal-bound
list validation. Web assignment and schema-4 consumption are implemented
together, with session-memory people data and complete graph facts.
Migration, raw-wire, snapshot, privacy, race and rollback checks retain these
boundaries.
