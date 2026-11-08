# Agent Note: Attachment HTTP Test Ownership

Status: implemented

## Problem

Attachment HTTP tests prepared PostgreSQL, authentication, Projects and Tasks
through the complete application before checking route parsing, response headers
or request failures. This coupled protocol feedback to unrelated storage and
setup work. The same suite included real streaming, file publication and
persistence observations, so changing its dependencies had to preserve the
mechanism responsible for each assertion.

The stalled-upload regression also waited for the production 60-second read
deadline. It needs a real incomplete TCP body, terminal rejection and subsequent
capacity recovery; the production-sized interval is incidental to that transport
proof.

## Decision

Existing attachment HTTP tests assemble the actual route, authentication and
attachment service adapters with controlled identity facts and strict callbacks
on the existing DAO and scope interfaces. The callbacks verify query and write
arguments, return explicit facts and errors, and fail on unconfigured access.
They do not emulate a persisted database or use SQL-string mocks. Valid domain
inputs replace Project and Task creation performed only for test preparation.

Native resource boundaries remain real. TCP tests use actual HTTP connections
and incomplete request bodies. Local-storage tests exercise real files,
publication, returned bytes and resource cleanup. Existing
[metadata DAO tests](../../../../packages/daynight-server/internal/core/store/postgres/attachment/dao_integration_test.go)
retain SQL, transaction and unchanged-state readback. Attachment lifecycle
witnesses retain admitted-stream publication and Task-deletion barriers, while
the [fresh-process witness](../../../../packages/daynight-server/cmd/daynight-server/persistence_process_test.go)
retains exact metadata and bytes across restart. The
[test-writing rules](../../../../docs/writing_tests.md) define these dependencies
and keep API integration and product E2E focused on normal flows.

The attachment handler owns its body-read duration. Production `RegisterRoutes`
initializes it to `transport.AttachmentBodyReadTimeout`, preserving 60 seconds.
The initialized default is checked independently of the shortened test duration.
The upload path passes that value unchanged to `httpx.NewDeadlineBody`. A
test-only route constructor uses the same handler and route registration with a
short local duration, so the TCP regression still exercises the production
deadline-body path. No public runtime configuration or independent timeout
implementation is introduced.

The HTTP test retains `408 request_timeout` for a stalled body, no partial
publication, released upload capacity and a subsequent successful write. Real
5 MiB content boundaries, fixed-length and chunked requests, actual over-limit
read bounds, path guards and response semantics remain exercised. The
[server attachment boundary decision](../architecture/2026-11-05-server-attachment-boundaries.md)
owns the file/metadata ordering; the
[HTTP input decision](../architecture/2026-11-07-http-input-boundaries.md)
owns first-read deadlines and definite terminal refusal responses.

## Alternatives

**Keep complete application fixtures for every HTTP assertion.** They provide
valid identities and stored resources but repeat database and authentication
preparation for protocol behavior that can use explicitly supplied facts.
Existing physical witnesses retain their native dependencies.

**Replace sockets and local storage with mocked reads and writes.** That would
remove the stalled-body deadline, publication and resource-release mechanisms
being verified. Only dependencies outside those mechanisms are controlled.

**Keep the production-sized wait.** It verifies the same transport lifecycle at
a higher repeated cost. The duration default and its connection to the real
deadline-body path remain independently visible, while the native stalled-body
case uses a short duration through that path.

## Consequences

HTTP parsing and response feedback executes without PostgreSQL preparation or a
complete product login flow. The existing scenarios retain their protocol and
native resource assertions, with storage durability checked by its actual owner.
The organization corrects existing tests and preserves their product scope.

An HTTP mock result does not establish database persistence, and a storage test
does not establish HTTP response behavior. Source-bound validation compares both
the corrected HTTP suite and the receiving physical-proof owners, alongside the
complete Go check, with matching cache, race, coverage and resource conditions.
Local package measurements do not by themselves establish faster hosted CI.
