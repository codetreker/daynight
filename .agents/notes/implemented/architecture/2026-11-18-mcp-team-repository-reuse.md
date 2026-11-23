# Agent Note: MCP Team-Scoped Repository Reuse

Status: implemented

## Problem

MCP registration could return a visible Project owned by another Team even when
the caller selected a different Team. Historic unparseable addresses could also
block the search, although they have no known repository identity.

## Decision

Registration resolves the target Team and reads at most two active, visible
Projects with that owner and persisted repository identity in one snapshot. Direct
Project grants remain sufficient for reuse. NULL identities do not match. A
unique match is returned without confirmation; otherwise ambiguity is refused or
confirmed creation uses the shared transaction. Independent repository resolution
retains its complete visible scope. This changes the registration lookup in the
[MCP Project decision](../feature/2026-11-06-mcp-project-management.md) and
uses the identity and write guarantee in the [Team uniqueness decision](2026-11-18-team-project-repository-uniqueness.md).

## Alternatives

**Filter the Team list.** That path requires Team membership and would exclude
callers with an independent Project grant.

**Filter all visible Projects in application code.** Scanning and reparsing
historical addresses is unnecessary and can fail on an unrelated NULL identity.

## Consequences

A concurrent or inaccessible occupant can still reject creation in the shared
transaction without disclosing the occupant. Snapshot completion errors and
unknown write outcomes retain their existing semantics.
