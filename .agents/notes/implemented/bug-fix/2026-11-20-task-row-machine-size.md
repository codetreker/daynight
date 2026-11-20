# Agent Note: Ordinary Task row machine record size

Status: implemented

## Problem

Worker machine records in ordinary Task rows were larger than adjacent dates,
platforms and durations. This gave a secondary fact the same prominence as the
Task title in both project and personal lists.

## Decision

The shared row's machine element inherits `--text-xs` from its parent for
current and historical records, absent or unknown records, and read failures.
The [Web specification](../../../../docs/spec/daynight-web.md#项目普通-task-行)
owns the visible contract. This extends the [ordinary row metadata decision](2026-11-20-task-row-metadata-size.md)
and refines the [semantic typography decision](../architecture/2026-11-20-web-semantic-typography.md).

## Alternatives

**Keep interface size.** It preserves the previous machine prominence but leaves
it inconsistent with adjacent secondary facts.

**Change shared machine presentation elsewhere.** Graphs, details and summaries
have independent layout and typography responsibilities.

## Consequences

The [list secondary text decision](2026-11-20-list-secondary-text-size.md) extends this hierarchy to assignees, Goal links and aggregate headers.

All ordinary row machine states scale with the browser root size alongside other
metadata. Existing wrapping and interaction remain intact; browser checks cover
long names, narrow layouts and enlarged text.
