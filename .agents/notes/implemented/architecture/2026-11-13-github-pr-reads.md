# Agent Note: Project GitHub PR Reads

Status: implemented

## Problem

Project members need bounded access to retained pull request observations and connection facts, including when GitHub is unavailable or the service is not configured. Authorization, counts and page contents must describe the same database observation.

## Decision

Expose separate Project-scoped status, summary list, detail and author directory reads. Each checks Project access in the same repeatable-read snapshot as its persisted facts. The list uses a scoped, validated keyset cursor with an upper number; summary queries exclude description. The directory derives one latest saved login per author ID, marks ambiguous names before searching and uses a revision-bound keyset cursor. Connection and channel state come from stored facts and current App authorization. The [author filter decision](2026-11-17-github-pr-author-filter.md) extends the list and its cursor without changing the unfiltered contract. The [silent reconciliation decision](../feature/2026-11-19-silent-pr-list-reconciliation.md) describes how the Web client uses these cursors. The [read design](../../../../docs/design/github-pr-reading.md) owns the public behavior; the [storage decision](2026-11-13-project-github-pr-storage.md) owns persistence.

## Alternatives

**Fetch GitHub during reads.** Remote availability and latency would prevent reading retained data and mix synchronization with Project authorization.

**Download PR pages to derive authors.** A current page omits authors elsewhere, while downloading every PR adds unbounded application materialization and unnecessary summaries. A separate persisted directory would add synchronization writes and a second lifecycle.

**Offset pagination.** New pull requests could shift earlier pages and duplicate loaded records; keysets retain a stable upper bound without freezing the collection.

## Consequences

Members can distinguish missing or failed reads from successful empty pages and continue reading retained observations offline or while synchronization is disabled. Page membership and counts may still change across requests as stored observations change. The author directory detects a changed revision between pages, but its projection still examines the project’s saved records; bounded output does not bound database work. Refreshing starts a new upper bound; this API does not provide synchronization or connection writes. The [synchronization setting decision](2026-11-14-project-github-sync-setting.md) distinguishes saved intent from execution and retained history.
