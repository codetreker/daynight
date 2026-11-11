# Agent Note: Web Project Task Search

Status: implemented

## Problem

The project list contains partial summaries and groups Tasks into ordinary
chains. A person searching IDs, complete titles and descriptions needs actual
matching Tasks, including historical completions and members absent from a
currently available graph, without losing the ordinary browsing position.

## Decision

The project task workspace submits an explicit expression to the server and
keeps its draft, applied query, filters and cursor pages separate from ordinary
lists. The server supplies matching, order and actual parent Goal context; the Web validates
the response and requests each known page. A changed cursor restarts at the
first page once. Identity, project and history fences withdraw stale results.
Search hits select the existing direct Task observation, which reads a complete
Task independently of the project graph. The [Web requirements](../../../../docs/spec/daynight-web.md#项目任务搜索)
and [design](../../../../docs/design/daynight-web.md) own the interaction and
lifecycle; the [server search decision](../architecture/2026-11-05-project-task-search.md)
and [direct observation decision](../architecture/2026-11-06-task-direct-observation.md)
own their respective contracts.

## Alternatives

**Search cached summaries.** Summaries omit complete descriptions, can lag the
server and cannot establish the matching evidence or the actual parent context.

**Treat a hit as a full Task.** The search projection lacks detail fields and
does not establish the epoch and version required for detail admission or writes.

## Consequences

Queries and page changes require network reads, and concurrent Task changes can
restart pagination. Separate state preserves ordinary browsing and avoids storing
complete project descriptions in the summary cache. Direct detail reads allow
valid hits to remain useful when graph synchronization is unavailable.
