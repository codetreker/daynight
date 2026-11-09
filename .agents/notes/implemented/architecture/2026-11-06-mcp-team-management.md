# Agent Note: MCP Team Management

Status: implemented

## Problem

MCP clients need to manage Teams and members using the same account authority,
version checks and completion facts as other service clients. Growing member
directories require explicit page selection and continuation without granting
Project-only users Team access.

## Decision

The MCP Team tools adapt shared Team and Project use cases with the request
principal. They resolve explicit Team selection, preserve separate Team and
membership versions, and submit at most one mutation after any required pre-read.
Member removal returns the committed actor role without a permission-sensitive
read after self-exit. Scoped pages authorize in the same snapshot as an ordinary
count-based DAO query, and cursors bind the account and Team. List items remain
complete; reads do not revalidate stored profile fields, admit encoded bytes or
truncate a growing response prefix.

The [ordinary resource-page decision](../simplification/2026-11-09-canonical-resource-pages.md)
removes the original stored-field and byte admission. The earlier
[encoded response decision](2026-11-07-encoded-response-budgets.md) retains its
historical rationale and current write guarantees. The
[authentication design](../../../../docs/design/daynight-auth.md#team-元数据与生命周期事务)
owns write serialization and the last-administrator rule. The
[MCP entry decision](2026-11-06-mcp-http-entry.md) owns authentication, input,
result envelopes and permit lifetimes.

## Alternatives

**Fetch the complete directory and truncate it in the adapter.** This would make
database work and materialization grow with the full directory even for a small
requested page. An ordinary count query preserves complete items and makes the
requested page limit effective. At the original decision, an encoded-byte bound
also motivated this alternative; that read budget is now superseded.

## Consequences

Members can navigate their Team directory and administrators can manage
memberships through MCP without granting Project-only users directory access.
Each page observes its own snapshot of the directory. The original oversized-item refusal could block further
traversal and deferred complete retrieval; ordinary count pages now retain full
items and continuation without that byte admission. Invitations remain a
separate capability. Complete REST directories retain their unpaged contract.
