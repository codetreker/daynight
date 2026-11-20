# Agent Note: Project Scope Admission

Status: implemented

## Problem

Project management exposes sensitive previews, membership and invitation data as
well as mutations. Credential permissions need to distinguish these operations
without weakening existing resource visibility, roles, credential rechecks or
transaction outcomes. Full responses can expose existing data beyond the input.

## Decision

Scoped Project service and REST and MCP adapters share the existing business
operations while requiring explicit credential authorization. They apply the
[shared scope contract](2026-11-20-credential-scope-contract.md) at the business
admission points before protected output or mutation. Resource visibility and
applicable roles remain mandatory. Full responses containing existing Project
or access data also require the corresponding read permission. The
[Project design](../../../../docs/design/project-scope-internal.md) owns the
operation mapping and assembly requirements.

Member candidate search and direct-member changes obtain current authorization
at their existing snapshot or transaction credential recheck boundaries. Missing
current readers fail closed. Existing production assembly remains unchanged.

## Alternatives

**Checks only in transport handlers.** Shared service callers could bypass them,
while credential revocation between the request and a transactional recheck
would not be observed.

**Write permission alone for full responses.** Existing replies contain access
or other prior data. Requiring read permission before mutation preserves the
response contract without disclosing that data to a write-only credential.

## Consequences

Denied operations do not expose restricted previews or perform protected writes;
existing resource, role, version and transaction completion rules remain in force.
Scoped assembly needs an authenticated request policy and authoritative current
readers bound to the original principal. Read-only snapshots need a compatible
policy reader rather than a write-transaction row lock. Persistence, authenticated
provider wiring and production activation remain separate work.
