# Agent Note: List secondary text size

Status: implemented

## Problem

Assignees, Goal links and aggregate status information in Task, chain and Goal
lists competed with titles and differed from adjacent secondary facts. Broad
list selectors could also override the sizes of expanded Task rows.

## Decision

Ordinary Task metadata and chain and Goal summary metadata and Session status
use `--text-xs`. Selectors for aggregate headers stop at their own headers;
shared components keep their defaults in graph and detail contexts. The
[Web specification](../../../../docs/spec/daynight-web.md#项目普通-task-行)
owns the visible contract. This extends the [ordinary row metadata decision](2026-11-20-task-row-metadata-size.md)
and [machine record decision](2026-11-20-task-row-machine-size.md).

## Alternatives

**Keep the larger secondary text.** It retains the previous hierarchy but leaves
adjacent metadata inconsistent and competes with the list titles.

**Change shared component defaults.** This would also affect graph and detail
contexts, which have separate typography and layout needs.

## Consequences

Metadata scales with the browser root size and stays subordinate to titles.
Header-scoped selectors keep expanded members governed by the shared row; browser
verification is needed for wrapping, status readability and unchanged interaction.
