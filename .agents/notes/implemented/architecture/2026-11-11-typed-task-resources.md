# Agent Note: Typed Task Resources

Status: implemented

## Problem

A container and its work items need the same resource identity, project access,
version and material ownership. Existing Task storage and resource projections
cannot distinguish a container from an executable item or express its direct
membership. Introducing a new resource through existing consumers before they can
read it would make ordinary operation unsafe.

## Decision

Task rows carry a type and nullable parent ID. Existing rows acquire `task` and
null through structural defaults; their business data is not converted. Full
and summary resource projections carry both fields, while narrow receipts and
references retain their own projections. Public creation selects the type and optional Parent; updates can change Parent
but never type. The shared
MCP output schemas describe the typed resource and Goal progress shape. MCP
creation and queries expose Type and Parent through the existing Task tools;
Parent updates preserve omitted, null and UUID inputs. Query cursors bind the
type and Parent scope, and the list fence covers visible resources of both types.
The adapter delegates type policy to the shared business service and retains
the original version and write outcome.

The CLI strictly reads the type and parent fields, accepts Goal progress and a
not-applicable Session observation, and confines graph nodes to ordinary Tasks.
Existing status and deletion commands read the target identity before writing;
Goal terminal transitions and deletion require an impact confirmation or an
explicit force flag. The preflight does not replace a caller's version or retry
an unknown write. These ID-based commands use the same resource identity as public Goal creation.

The [server design](../../../../docs/design/daynight-server.md) owns the deployed
storage and API mechanics. Core type policy and Project-scoped writes enforce the Goal capability and
parent rules. The [resource read decision](2026-11-11-typed-task-resource-reads.md)
owns typed selection, effective visibility and derived Goal progress.

## Alternatives

**Separate Goal table.** This would duplicate or extract the identity, access,
version, Thread and attachment ownership shared with Task, while child visibility
would still require coordination.

**Shared base table with Task and Goal subtype tables.** Multiple tables and
joins would add atomicity and ownership costs without a demonstrated third
resource type requiring that structure.

## Consequences

Existing ordinary data keeps its identity and behavior, and consumers can learn
the added fields before new resource types are publicly created. The database
does not enforce cross-row parent semantics; business operations own those checks.
Typed reads supply visibility and derived progress; Goal lifecycle and parent
mutation use the Project write scope. CLI preflight adds a read even when the
caller supplies a version; the server remains authoritative for writes.
