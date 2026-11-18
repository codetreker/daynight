# Agent Note: MCP Project Management

Status: implemented

## Problem

Remote clients need to resolve, register, inspect and transfer Projects without relying
on the server's local Git state or losing the CLI's repository reuse and
transfer preconditions.

## Decision

The Project MCP tools use the shared authenticated entry and existing Project
use cases. The later [Team-scoped reuse decision](../architecture/2026-11-18-mcp-team-repository-reuse.md) selects registration matches within the target Team. A unique match is reused, multiple matches are refused, and a new Project requires explicit confirmation. The stored address remains unchanged. Transfer submits the observed source
ownership and destination Team versions and returns the actual receipt.
Read-only repository resolution uses complete visible-project traversal and returns a
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

Identification does not grant access or use a local Team default. The later
[Team uniqueness decision](../architecture/2026-11-18-team-project-repository-uniqueness.md)
constrains actual creation and transfer within each owner Team; conflicting
concurrent writes are refused. Cross-Team Projects can still make read-only discovery ambiguous. The identity rules remain aligned with the CLI, including paths that cannot safely be treated as equivalent. The resolution scan is linear in visible Projects, retaining one page and one match.
