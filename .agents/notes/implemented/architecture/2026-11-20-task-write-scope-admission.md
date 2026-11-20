# Agent Note: Task Write Scope Admission

Status: implemented

## Problem

Task mutations combine independent fields and may return prior Task data. A
credential authorized to change a title, execution permission, dependencies or
status must not gain the other abilities or read unrelated content through the
write response. A partial mutation would also violate the existing atomic write
contract.

## Decision

The Task service classifies the parsed mutation as a union of required operations
and applies the shared scope guard alongside existing resource and lifecycle
admission before mutation. Task Tag associations are Task writes; catalog
management remains independent. Ordinary status and claim-bound completion use
separate operations. Explicit scoped REST and MCP adapters carry the authenticated
policy and response selection into the same service operations. Legacy production
assembly remains unchanged.

Full Task and property responses require Task read permission before writing.
An explicit REST receipt or MCP receipt contains only the Project and Task IDs
and resulting version; MCP also retains its write outcome. MCP defaults to that
receipt for a restricted credential without Task read permission. Its optional
version lookup remains a read and requires that permission. The service measures
MCP receipt framing before transaction completion.

The [internal design](../../../../docs/design/credential-scope-internal.md) owns
operation mapping and assembly boundaries; the [scope contract decision](2026-11-20-credential-scope-contract.md)
owns the shared vocabulary and credential policy.

## Alternatives

**Infer permission from the endpoint.** A Task update can combine fields with
different permissions. An endpoint-wide permission would either grant unrelated
changes or deny independent operations.

**Return the full Task for write-only credentials.** Existing representations
include fields unrelated to the submitted change. A minimal receipt preserves
confirmation without disclosing those fields.

## Consequences

Every requested permission is required before the write, preserving atomic
refusal and existing role, version and claim checks. Receipt consumers must read
separately when they need the Task contents. Current request authorization uses
the authenticated policy snapshot; existing production assembly and activation
of scoped credentials remain separate work.
