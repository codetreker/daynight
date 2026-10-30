# Agent Note: Task Property Rows

Status: implemented

## Problem

A fixed property document couples every task property to transport fields,
whole-document storage, command-specific parsing and read defaults. Removing a
property cannot be represented independently of an empty array or null.
Execution ownership also needs the same task-level transaction and session fence
when its storage stops sharing the parent task row.

## Decision

The [property design](../../../../docs/design/daynight-task-properties.md) uses a
server-owned static definition registry and a generic JSON property map.
Definitions own value decoding, normalization, schemas and public writability.
Business readers decode PR lists and worker claims only where those values are
used. Generic transports preserve every property key, and readers never
materialize missing properties.

Each task/property is one row in task_properties, keyed by task_id and name.
The value is one complete JSON value stored as text. Task UUIDs are globally
unique; project authorization is checked through the parent, so the property
table does not duplicate project_id or add a foreign key. Nested arrays and
objects remain whole values. Properties have no independent version, timestamps
or tombstones.

A real set or removal updates the property rows and the parent task version and
updated_at in one transaction. Parent task locks precede property and Session
operations, preserving the relay's shared parent-task fence even when a worker
row is absent. Reads batch-load rows in the same repeatable-read snapshot as
their tasks; worker matching still precedes final pagination.

The [original property-column decision](../../archived/architecture/2026-10-21-task-properties-design.md)
introduced one typed JSON text document when the property catalog and its public
operation were a concrete PR list. It preserved opaque strings and reused a
single-row task write. The row model supersedes its fixed-document storage and
required-field representation while retaining its PR and JSON-text semantics.
That archive remains unchanged.

The frozen legacy migration validates and normalizes old values inside one
migration transaction, preserves all PR values including empty arrays, maps
worker:null to absence, and retains non-null claim/session identity. It drops the
old column without changing task versions or business times. New migration
checksums cover the frozen transform as well as SQL; historical SQL and checksums
stay immutable. Runtime readers accept only the new model.

Illegal property values, including malformed stored values, produce identifiable
validation errors mapped to HTTP 400 invalid_input. Database and other internal
faults remain HTTP 500 internal_error. Both retain error chains and sanitized
diagnostics; neither returns partial values or silently deletes corrupt data.

The [claim foundation](2026-10-24-worker-claim-foundation.md) retains authority
over worker lifecycle. No retained claim means an absent worker property;
release and completion keep history objects, and withdrawal removes the row.
Public property mutations cannot set or remove worker.

CLI and Web generic readers adopt absence at the same model boundary. The Web
cache schema rebuild invalidates old null/required-property details before
same-version comparisons. Existing PR command options still write an explicit
array, and task-sync retains its compact property-free projection.

## Alternatives

**Keep one JSON document per task.** It reuses one row but keeps all property
presence and updates tied to a whole document and fixed readers. The requested
single-property setting and true removal map directly to property rows.

**Split PR items or every nested scalar into rows.** That would support
independent item operations, but the current value is an ordered whole list.
Item identities, nested ordering and per-item writes are additional contracts.

**Use JSONB values.** Database JSON queries are not needed for this model.
JSONB Unicode conversion would restrict opaque strings already accepted by the
property contract, including escaped NUL.

**Keep concrete DTO fields or validate from the CLI.** Both duplicate the
server's catalog across consumers. Generic maps preserve unknown-to-client
properties; a native server validator and schema agreement tests preserve
business constraints without a runtime schema engine.

**Give each property an independent version.** It reduces unrelated-property
conflicts but would split atomic task/field/dependency mutations and worker
session fencing. The task remains the concurrency and synchronization unit.

## Consequences

Presence is observable: missing pullRequests differs from an explicit empty
array, while both can use the existing empty PR presentation. Client parsers and
business callers must handle absence without hiding invalid present values.
Immutable candidate maps avoid contaminating current snapshots during writes.

The row model adds one batched value query to ordinary full reads. It does not
introduce arbitrary custom attributes, JSON filtering, a claim history table or
a new synchronization protocol. Those capabilities need their own semantics if
required. Complete task/list payloads still grow with property content and retain
the existing explicit response limits.

The storage transition changes the full-resource contract and requires
coordinated server/client upgrades. Task-level versions and timestamps stay
unchanged by migration, so cache invalidation belongs with that model change.
Rollback after dropping the column requires database recovery or a verified
reverse migration, not merely an old executable.
