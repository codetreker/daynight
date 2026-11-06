# Agent Note: Attachment MIME Byte Limit

Status: implemented

## Problem

An attachment's MIME metadata has no size bound on new writes. A single value
can grow without limit, while existing stored values must remain accessible.

## Decision

The shared attachment write validation rejects original MIME values over 2048
bytes before acquiring the target gate or publishing file content. MIME syntax
validation and the HTTP default remain unchanged. The limit applies only to new
writes; historical values are preserved for reading, listing and deletion.
The [attachment requirements](../../../../docs/spec/daynight-task-attachments.md)
and [design](../../../../docs/design/daynight-task-attachments.md) own the contract
and ordering.

## Alternatives

**Limit only HTTP headers.** Other consumers of the shared attachment write use
case could bypass that restriction and store unbounded metadata.

**Enforce a database constraint or rewrite historical values.** This would
reject or alter existing records and could break their established access paths.

## Consequences

New metadata is bounded consistently across write consumers without changing the
existing target gate or the non-atomic file and database failure semantics.
Historical oversized metadata remains unbounded on reads; this limit alone does
not guarantee bounded MCP output or complete MCP access to such records.
