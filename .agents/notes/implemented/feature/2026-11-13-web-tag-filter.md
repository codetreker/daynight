# Agent Note: Web Tag Filtering

Status: implemented

## Problem

Project browsing and text search need the same tag conditions without confusing
missing tags with empty results or changing the graph used for context. Goal
children have their own Parent scope and do not determine their Goal's tags.

## Decision

The project workspace shares a tag condition between local browsing and remote
search. The original child-filter decision gave each expanded Goal an independent
condition because its direct-child rows have their own Parent scope. The
[unified toolbar decision](2026-11-14-unified-tag-filter-toolbar.md) replaces that
ownership with one project-owned child condition while retaining direct-child
matching and its independence from Goal tags. Local matching uses each summary's tags over the complete graph; a top-level
chain remains visible when a member in its scope matches. Search sends canonical IDs, mode and type on every
page and checks returned qualifications. Selected names survive catalog paging;
resolve and server errors identify invalid conditions that remain until removed.
Explicit overview navigation validates and clears a valid tag condition when it
would hide the target, preserving the destination page; an unavailable selection
remains until the user removes it. A detail relation hidden by the tag condition
opens directly while retaining the condition.
The [Web design](../../../../docs/design/daynight-web.md) describes the owners
and the [Web search decision](2026-11-06-web-task-search.md) retains the search
lifecycle rationale.

## Alternatives

**Filter graph nodes.** Removing nonmatching nodes would lose dependencies and
change the existing chain context and progress.

**Treat a missing catalog page entry as deleted.** A paged directory is not a
complete inventory; selected IDs outside the page require resolution.

## Consequences

Search and browsing keep consistent tag semantics while retaining independent
text and status state. Catalog revalidation adds reads for selected IDs; failed
or invalid conditions remain visible instead of silently widening results.
