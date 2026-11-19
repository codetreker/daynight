# Agent Note: MCP Goal Acceptance Relationships

Status: implemented

## Problem

MCP clients need to inspect and edit Goal acceptance dependencies without treating them as ordinary Task scheduling edges. Callers must preserve exact relationship revisions and handle inaccessible endpoints without disclosing their identities.

## Decision

The MCP server exposes separate `goal_dependencies_show` and `goal_dependencies_edit` tools using the authorized Goal relationship service and the shared [relationship protocol](2026-11-19-goal-dependency-rest.md). Reads return the bounded prerequisite projection and a page of successors; edits accept the same revision and edit/replace operations as REST. Both use the existing control budget and MCP authorization, result and failure conventions. The MCP manuals describe the independent relationship and its lifecycle.

## Alternatives

**Extend ordinary Task dependency tools.** Ordinary dependencies have different scheduling semantics, versioning and visibility. Reusing those inputs would conflate two relationship types and risk changing existing clients' behavior.

## Consequences

A normal read takes one tool call; an edit based on a current observation normally takes two. Editors can retain or remove hidden edges by opaque ID, and an unknown write outcome must be observed without automatic replay. Successor pages are bounded by count, with full permitted endpoint text retained; control-budget concurrency limits apply independently of response size.
