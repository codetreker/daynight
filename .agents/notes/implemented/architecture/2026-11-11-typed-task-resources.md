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
references retain their own projections. Ordinary creation explicitly supplies
`task` and no parent, and public writes do not expose either field. The shared
MCP output schemas describe the typed resource and Goal progress shape.

The [server design](../../../../docs/design/daynight-server.md) owns the deployed
storage and API mechanics. Type-specific operations and public creation remain separate capabilities.
The [resource read decision](2026-11-11-typed-task-resource-reads.md) owns typed
selection, effective visibility and derived Goal progress.

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
does not enforce cross-row parent semantics; business operations own those checks. Typed reads supply visibility and derived
progress; Goal lifecycle and parent mutation remain separate capabilities.
