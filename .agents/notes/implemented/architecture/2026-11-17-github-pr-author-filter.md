# Agent Note: GitHub PR Author Filter

Status: implemented

## Problem

Project members need to read all retained pull requests for a GitHub author in combination with state and search, including records beyond the current page. Existing clients also rely on project-wide counts and their existing pagination cursors.

## Decision

Filter the saved author's stable ID in SQL before pagination. Author-scoped state counts and the independent project total are read with the page in the existing authorized snapshot. Unfiltered reads retain their original response and v1 cursor; author-filtered reads return the author and project total with a v2 cursor bound to that author. The [read design](../../../../docs/design/github-pr-reading.md) owns the protocol and the [storage design](../../../../docs/design/github-pr-storage.md) owns the index and migration. This extends the [PR reads decision](2026-11-13-github-pr-reads.md).

## Alternatives

**Filter the current page or download all PRs.** Page-local filtering misses matches and produces incorrect counts, while downloading all summaries makes client work grow with the full collection.

**Replace every cursor with v2.** Existing clients synthesize and retain v1 cursors, so a universal replacement would interrupt their reads after a server upgrade.

**Add a separate author table.** The stored author ID already supports this filter; a separate table would add synchronization and lifecycle obligations. A bounded author directory is a separate capability.

## Consequences

The partial author index adds storage and write cost, while project totals still require project-wide aggregation. The project total distinguishes a filtered empty result from an empty project. An unknown valid author ID can be queried without directory membership and matches no records unless that ID is stored. This API reads saved facts only and does not fetch GitHub data; the separate author directory derives its entries from the same saved observations.
