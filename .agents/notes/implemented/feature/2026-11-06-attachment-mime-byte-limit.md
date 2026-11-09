# Agent Note: Attachment MIME Byte Limit

Status: implemented

## Problem

At the original decision, attachment MIME metadata had no size bound on writes.
A single value could grow without limit, and applying a database-wide limit or
rewriting historical values would have changed existing access and data.

## Decision

Shared attachment write validation rejects original MIME values over 2048 bytes
before acquiring the target gate or publishing file content. MIME syntax
validation and the HTTP default remain unchanged. Reads consume canonical stored
metadata without repeat field or capacity admission, as recorded in the
[ordinary resource-page decision](../simplification/2026-11-09-canonical-resource-pages.md).
That decision removes historical read guarantees and adds no scan or migration.

The original write limit preserved historical values for reading, listing and
deletion. The limit applied at write ingress. The
[attachment requirements](../../../../docs/spec/daynight-task-attachments.md) and
[design](../../../../docs/design/daynight-task-attachments.md) own current contract
and ordering.

## Alternatives

**Limit only HTTP headers.** Other consumers of the shared attachment write use
case could bypass that restriction and store unbounded metadata.

**Enforce a database constraint or rewrite historical values.** This would
reject or alter existing records and could break their established access paths.

## Consequences

New metadata is bounded consistently across write consumers without changing
the target gate or non-atomic file and database failure semantics. At adoption,
that limit alone did not bound historical metadata reads or guarantee complete
MCP access to those records. Current reads add no metadata or output admission;
accepted writes, actual file I/O and natural errors retain their separate owners.
