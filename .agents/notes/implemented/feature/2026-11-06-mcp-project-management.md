# Agent Note: MCP Project Management

Status: implemented

## Problem

Remote clients need to register, inspect and transfer Projects without relying
on the server's local Git state or losing the CLI's repository reuse and
transfer preconditions.

## Decision

The Project MCP tools use the shared authenticated entry and existing Project
use cases. Repository registration compares normalized identities across the
caller's visible Projects in a snapshot. A unique match is reused, multiple
matches are refused, and a new Project requires explicit confirmation. The
stored address remains unchanged. Transfer submits the observed source
ownership and destination Team versions and returns the actual receipt.

## Alternatives

**Make repository identity globally unique.** Existing Projects can intentionally
share a repository, and a global constraint would change their creation and
visibility semantics.

**Reimplement Project writes in the protocol adapter.** This would duplicate
authorization, locking and transaction completion rules already owned by the
Project services.

## Consequences

Identification does not grant access or use a local Team default. Concurrent
registrations can still create duplicate Projects; later discovery reports the
ambiguity instead of selecting one. The identity rules must remain aligned with
the CLI, including paths that cannot safely be treated as equivalent.
