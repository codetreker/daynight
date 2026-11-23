# Agent Note: Web PR Author Selection

Status: implemented

## Problem

A PR workspace needs complete author filtering without treating the current page as the author directory or presenting old results under a new selection. List and directory requests can finish after identity or Project access changes, and a directory revision can change while multiple pages are visible.

## Decision

The workspace retains the selected GitHub ID and label independently of the searched author directory. The list owns author-scoped counts, query, page and upper bound; the directory owns its search and revision-bound pages. A shared read session fences both channels on identity and access changes. Directory conflicts rebuild a separate snapshot through the visible range and anchors before replacing it. The [PR read design](../../../../docs/design/github-pr-reading.md) owns the interaction and protocol details; the [server author filter](2026-11-17-github-pr-author-filter.md) owns the server-side selection and cursor contract.

## Alternatives

**Derive candidates from the visible PR page.** Authors on later pages or in other states would be missing, and local filtering would misstate counts.

**Replace the directory with its new first page after a conflict.** This discards previously loaded candidates and reading position even when the user has not changed the search. Staging preserves the old list until the relevant range and anchors can be reconciled.

**Use independent authorization fences for both reads.** A trusted rejection in one channel could allow a late success in the other to restore private data before the next render.

## Consequences

A long directory rebuild may need additional pages to locate a renamed anchor and can fail its total deadline; the old list remains usable with an explicit retry. The directory uses the existing Project revision, so unrelated synchronization can conservatively cause a conflict. The selection remains in memory for the mounted workspace and does not create persistent preferences or trigger GitHub synchronization.
