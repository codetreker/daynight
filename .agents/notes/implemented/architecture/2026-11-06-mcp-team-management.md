# Agent Note: MCP Team Management

Status: implemented

## Problem

MCP clients need to manage Teams and members using the same account authority,
version checks and completion facts as other service clients. Unbounded member
reads cannot support bounded tool responses as directories grow.

## Decision

The MCP Team tools adapt the shared Team and Project use cases with the request
principal. They resolve an explicit Team selection, preserve separate Team and
membership versions, and submit at most one mutation after any required pre-read.
Member removal returns the committed actor role without a permission-sensitive
read after self-exit. Scoped member pages authorize in the same snapshot as the
bounded DAO query, and cursors bind the account and Team. List items remain
complete; an item that exceeds the response budget returns an explicit error.
Member profile fields are bounded before materialization.

The [Team membership decision](2026-11-04-team-membership-management.md) owns
write serialization and the last-administrator rule. The [MCP entry decision](2026-11-06-mcp-http-entry.md)
owns authentication, result envelopes and resource admission.

## Alternatives

**Fetch the complete directory and truncate it in the adapter.** This would make
memory and database work grow with the full directory even for a small page.
A bounded query preserves complete items and makes the page limit effective.

## Consequences

Members can navigate their own Team directory and administrators can manage
existing memberships through MCP without granting Project-only users directory
access. Pagination reflects successive snapshots; it does not freeze a changing
directory across calls. An oversized item prevents further traversal from its
position; complete MCP retrieval and continuation need a separate bounded-read
contract. The current cursor preserves the position before that item so a future
contract can add continuation without changing earlier pages. Invitations remain
a separate capability.
