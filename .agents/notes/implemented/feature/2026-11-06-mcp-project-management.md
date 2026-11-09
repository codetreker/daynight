# Agent Note: MCP Project Management

Status: implemented

## Problem

Remote clients need to resolve, register, inspect and transfer Projects without relying
on the server's local Git state or losing the CLI's repository reuse and
transfer preconditions.

## Decision

The Project MCP tools use the shared authenticated entry and existing Project
use cases. Repository registration compares normalized identities across the
caller's visible Projects in a snapshot. A unique match is reused, multiple
matches are refused, and a new Project requires explicit confirmation. The
stored address remains unchanged. Transfer submits the observed source
ownership and destination Team versions and returns the actual receipt.
Read-only repository resolution uses the same complete traversal and returns a
Project only after its snapshot completes. It neither creates nor binds a Project;
later operations recheck access.

## Alternatives

**Make repository identity globally unique.** Existing Projects can intentionally
share a repository, and a global constraint would change their creation and
visibility semantics.

**Resolve by paging through public list calls.** Separate snapshots could observe
different access or Project state and incorrectly report a unique match.

**Reimplement Project writes in the protocol adapter.** This would duplicate
authorization, locking and transaction completion rules already owned by the
Project services.

## Consequences

Identification does not grant access or use a local Team default. Concurrent
registrations can still create duplicate Projects; later discovery reports the
ambiguity instead of selecting one. The identity rules must remain aligned with
the CLI, including paths that cannot safely be treated as equivalent.
The scan is linear in visible Projects, retaining one page and one match; an
identity index would require coordinated identity versioning and migration.
