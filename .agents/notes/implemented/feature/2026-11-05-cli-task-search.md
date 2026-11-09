# Agent Note: CLI Task Search

Status: implemented

## Problem

Terminal users need to find Tasks by their ID, complete title or description, including
completed work, without mistaking a partial page or a locally reordered list for
complete search results. The service search projection also contains fields that
the compact CLI result does not promise to expose.

## Decision

`task search` sends one unchanged expression and the selected filters to the
server, reads and validates all pages before output, and preserves their order.
Text and JSON share an explicit compact projection; the full Task remains
available through `task show`. The command retains the shared operation's time,
response and aggregate byte budgets and reports page failures without partial
stdout. The [CLI requirements](../../../../docs/spec/daynight-project-task.md#项目任务搜索)
and [design](../../../../docs/design/daynight-project-task.md#task-搜索) own its
behavior and mechanism. The [server search decision](../architecture/2026-11-05-project-task-search.md)
owns expression, evidence and pagination semantics.

## Alternatives

**Reuse ordinary task list.** Its default excludes completed Tasks and its status
grouping changes the relevance order. It also cannot search full descriptions.

**Return a limited page.** A silent cap or partial result would not satisfy the
complete-search contract and could hide the desired Task. Explicit shared budgets
bound the operation while making failures visible.

## Consequences

Large result sets consume time and memory, and a project change during pagination
requires a fresh search. Waiting until all pages succeed prevents a failed read
from presenting a partial set as complete. Explicit fields keep future server
wire additions out of both CLI formats.
