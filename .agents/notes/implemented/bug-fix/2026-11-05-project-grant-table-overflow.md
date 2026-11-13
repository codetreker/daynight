# Agent Note: Project Grant Table Overflow

Status: implemented

## Problem

The five-column Members row needs more space than the content area at intermediate
viewport widths with an expanded sidebar. The panel clips its final action column,
and scrolling only below 700px leaves grant removal unreachable at 768px and 800px.

## Decision

The grant table permits horizontal scrolling whenever its columns exceed its own
container. Its existing column widths and layout at 700px and below remain in place.
The [auth specification](../../../../docs/spec/daynight-auth.md#web-交互与状态)
owns reachability, and the [auth design](../../../../docs/design/daynight-auth.md)
describes the local scrolling mechanism. The existing
[grant management decision](../../archived/architecture/2026-11-04-project-grant-management.md)
records the rationale for the existing mutation and access-receipt mechanisms.
The [grant row isolation decision](2026-11-13-grant-row-style-isolation.md)
keeps the account authorization layout from overriding these five columns.

## Alternatives

**Raise the viewport breakpoint.** A larger fixed breakpoint would cover the known
sidebar layout but still couple control reachability to viewport width rather than
the table's available space. Local overflow handles the actual container directly.

**Reduce the five column minimums.** This would compress identities, role sources
and controls to compensate for sidebar width and change their existing presentation.
Retaining the columns preserves the grant workflow while making its actions reachable.

## Consequences

Overflow stays inside the Members table and does not widen the page. Narrow users
retain horizontal scrolling; wide tables that already fit do not gain overflow.
The production-Application browser fixture checks pointer removal and its confirmed
versioned write at 700px, 768px, 800px and 1280px. Intermediate widths use the expanded
sidebar. No production telemetry or backend behavior changes.
