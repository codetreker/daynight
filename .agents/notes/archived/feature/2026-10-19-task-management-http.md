# Agent Note: Project-scoped Task HTTP Boundary

Status: implemented

## Problem

Clients need task mutations whose HTTP representation preserves omitted fields,
explicit refusals, dependency sets and expected versions. Treating JSON null as
an empty string or slice can turn an invalid update into a destructive clear.
Unscoped cursors or error logs can also misattribute work to another project or
hide the cause of a rejected mutation.

## Decision

The server exposes task create/list/get/update and one versioned PUT status
beneath a project path. The [status assignment decision](../../implemented/architecture/2026-10-24-task-status-assignment.md)
replaces the historical generic update and approval-action contracts. It
converts API DTOs into the existing concrete task service without SQL or policy
duplication in handlers. The runtime factory constructs project and task services
from one store, with explicit typed handler dependencies and one request-logging
middleware.

JSON parsing distinguishes omission from null before unmarshalling strings or
arrays. Creation assigns its documented empty optional values; updates require
a positive int64 version and at least one mutable metadata field. Status is not
a metadata input. Lifecycle POST requests accept only the positive int64 version;
wrong predecessor states map to invalid_transition without mutation. Null array elements,
unknown/read-only fields, duplicate keys, malformed UTF-8 and noninteger versions
are input errors. Supplied empty description or dependency list has explicit
clear semantics rather than acting as a default for invalid data.

Task lists parse status and literal boolean readiness separately from pagination.
The service binds them to the canonical project in its cursor and applies filters
before keyset paging. Missing project and wrong-project task results stay 404;
an existing project with no tasks is a successful empty page.

Known service conflicts map to 409 with sorted `error.details.taskIds` where
relevant. Shared error handling takes an explicit component and phase, and known
domain refusals receive useful structured categories. Cancellation, database and
network errors take precedence over business markers. Unknown failures retain a
fixed response and sanitized diagnostic. Resource logs use validated UUIDs and
request correlation, never raw paths, URLs, bodies or driver messages.

Cancelled responses write neither bodies nor creation Location headers. Standard
HEAD and method-not-allowed behavior remain consistent for project and task
routes. The [requirements](../../../../docs/spec/daynight-server.md) own complete
HTTP behavior; the [task policy](2026-10-19-task-dependency-policy.md) retains
ownership of dependency, state and version decisions.

## Alternatives

**Unmarshal optional fields directly into strings and slices.** JSON null would
silently become their zero values, conflating refusal with clearing. Inspecting
the raw optional value first preserves the selected mutation semantics.

**Keep a project-specific error helper for all routes.** Task failures would be
logged as project operations, and dependency refusals would appear internal.
Explicit component/phase plus known fault categories preserve attribution while
sharing the same response code.

**Preserve the old handler constructor with optional task dependencies.** An
omitted task service would defer a composition error until runtime. Explicit
typed project/task dependencies make all existing call sites update together.

## Consequences

All project and task HTTP operations now share input, pagination, cancellation,
correlation and error envelopes. Dependency policy remains in service, including
the distinction between a safe expected refusal and transaction completion
failure. There is no alternative persistence path or compatibility fallback.

Real PostgreSQL HTTP tests cover default values, strict field semantics, versions
and no-ops, cycles and status gates, cross-project lookup, scoped filtered pages,
internal failures and cancellation. Command tests exercise the wired task routes.
The remaining delivery task verifies the built process, restart persistence,
cross-layer races, bounded shutdown and CI evidence.
