# Agent Note: Repository-linked Project API

Status: implemented

## Problem

Tasks need a durable project identity and repository association that callers can
create and query. Local reviewer configuration is tied to its own startup and
clone lifecycle, so it cannot also serve as the service's project registry.
HTTP input and storage failures need distinguishable, safe outcomes.

## Decision

The service implements project creation, list and get through `/api/v1/projects`.
`api` owns transport DTOs, `server` owns HTTP parsing and responses, and `service`
owns validation, identity, cursor scope and storage calls. The existing runtime
factory passes the same concrete store into service construction. Business HTTP
handlers issue no SQL and do not create another pool.

Projects receive UUIDs and retain accepted name/address spelling. Registration
checks HTTPS, SSH URL and SCP syntax without network or Git operations. It
accepts SSH aliases and repository paths containing `@`; provider-specific
repository identity and filesystem paths remain outside this registry. Address
credentials, control characters and ambiguous credential-like SCP forms are
refused. Multiple projects may reference the same repository.

The HTTP boundary accepts exact-case fields in a single bounded UTF-8 JSON
object, rejects duplicate and unknown keys, and distinguishes omitted parameters
from explicit invalid values. Project list cursors carry a format version,
resource/filter scope and exact keyset position. One response uses a database
snapshot, while multiple pages do not claim one shared snapshot.

Service faults carry safe domain messages and retain causes. Missing-resource
outcomes are held until their read-only snapshot completes successfully. An
operational commit or cleanup failure takes precedence over not-found, even if
its cause chain also contains the missing-resource marker. HTTP maps only typed
service faults; internal errors use a fixed response and correlated diagnostics.
Unsupported methods use JSON `405` plus `Allow`.

The [requirements](../../../../docs/spec/daynight-server.md) own observable
behavior and the [design](../../../../docs/design/daynight-server.md) owns the
layer and transaction mechanisms. The
[design baseline](../architecture/2026-10-19-daynight-server-task-design.md)
continues to define pending task-management behavior.

## Alternatives

**Use a repository URL as project identity.** Different work streams can target
the same repository. A generated project ID permits those independent projects
without changing repository address semantics.

**Map any missing-resource cause to HTTP 404.** A transaction can join a missing
row with a real completion or cleanup failure. Waiting for the transaction
outcome preserves that failure instead of presenting a misleading domain refusal.

**Rely only on struct JSON decoding for strict input.** Standard decoding accepts
case-insensitive matches and duplicate keys. Explicit object parsing enforces
the selected field and update semantics without echoing submitted values.

**Require DNS labels for every SSH host.** SSH aliases and URI reg-name hosts can
contain underscores and other valid characters. Syntax checks separate authority
and path without requiring DNS resolution or rejecting repository `@` characters.

## Consequences

Project APIs can be verified independently before task endpoints are added.
Real PostgreSQL service and HTTP tests cover persisted resources, same-repository
projects, tied-timestamp pages, cursor scope, transaction completion failures,
typed errors and cancellation during a database wait. Request IDs and canonical
project IDs provide correlation without raw URLs or request bodies.

Task operations can reuse the same service-fault, cursor and HTTP input mechanisms.
They still need their own dependency/state/version policy and project-scoped
routes. Strict whole-module coverage and the existing native CLI checks remain
required throughout that implementation.
