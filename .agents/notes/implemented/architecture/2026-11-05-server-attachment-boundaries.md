# Agent Note: Server Attachment Boundaries

Status: implemented

## Problem

Attachment addressing, metadata rules, file operations and HTTP handling shared
root packages and a concrete database dependency. This obscured the ordering and
failure boundaries between storage and metadata and coupled consumers to the
current database implementation.

## Decision

`core/attachment` owns canonical addresses, MIME validation, path conflicts,
metadata and attachment pagination. `service/attachment` combines Project and
Task admission with file and metadata operations through snapshot and ordinary
attachment writer capabilities. `server/attachment` handles routes, streaming
and the raw path guard used before mux normalization, including standalone pages.

Files are written or deleted before metadata. A later metadata failure is
reported without undoing the file operation; the two stores are not atomic.
The physical address remains project and task scoped. The [PostgreSQL backend](2026-11-05-server-postgres-ownership.md) owns the
metadata implementation.

## Alternatives

**Keep attachment operations in the service root with a concrete Store.** This
would preserve behavior but leave domain rules and orchestration tied to the
database implementation and make independent consumers harder to assemble.

## Consequences

Readers share the authorization snapshot, and completion errors remain visible
ahead of staged refusals. File operations do not hold that snapshot open. The
metadata writer does not imply a transaction spanning file storage and SQL.
