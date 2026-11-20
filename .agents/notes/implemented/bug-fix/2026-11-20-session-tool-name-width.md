# Agent Note: Readable Session Tool Names

Status: implemented

## Problem

Names sharing a long namespace can appear identical in a narrow Session timeline.
The disclosure did not show the full native name, so readers could not identify
which tool ran without relying on a hover title or assistive technology.

## Decision

The shared timeline uses its content width to arrange tool summaries. Below
480px the input summary has its own line, leaving the name and status together.
Names with MCP namespace segments show a shortened operation name in that space;
the accessible name and expanded details retain the native identifier. Wider
summaries remain on one line. The [Session specification](../../../../docs/spec/task-sessions.md)
owns the visible behavior and the input, output and status guarantees.

## Alternatives

**Keep all summaries on one line.** The earlier [compact-row decision](../../archived/bug-fix/2026-10-28-session-empty-reasoning-and-tool-rows.md)
reserved a stable line for repeated commands, but shared namespaces can consume
that limited name column before the distinguishing operation is visible.

**Show only the full name on expansion.** This makes identification possible
but still forces readers to open each otherwise indistinguishable row.

## Consequences

Readers can distinguish common names while keeping the native identifier
selectable in expanded content. Long operation names can still be abbreviated;
the exact name remains available without a hover. The layout changes with the
reading area, including embedded Session views, without remounting disclosures.
