# Agent Note: Controller Bot History Cache

Status: implemented

## Problem

Long-running Bots can continue writing display history long after users stop
reading the oldest turns. A verbose turn can exhaust the local timeline on its
own. UI cursors, late Provider revisions, and active image readers must continue
to have predictable behavior as local history expires.

## Decision

Use the Bot Controller journal transaction to publish bounded display entries,
preview metadata, stable identities, eviction boundaries, and resource cleanup
candidates. A user message establishes a round boundary. Evict old rounds
first and summarize older tool details within an oversized active round. Keep
the original identity after eviction so native replay cannot reopen the window.

Publish a source-fenced server checkpoint and serve the corresponding immutable
window. The checkpoint receipt allows local cleanup to inspect candidates.
Operation evidence and pending interactions retain their own lifecycle.

The [Bot history design](../../../../docs/design/bot-history-window.md) owns
the wire and retention contracts.

## Alternatives

**Delete rows on an independent maintenance schedule.** A write can exceed the
display budget before cleanup runs. Independent deletion also complicates
publishing an atomic boundary and determining which resources the window owned.

**Derive the next sequence from retained entries.** Clearing the final entry
would lose the original high water and allow a replayed ID or old cursor to
refer to a newly written entry.

## Consequences

The cache budget includes encoded display rows and their retained projections.
SQLite page allocation, WAL, stable identity metadata, and independent
execution and media lifecycles contribute separately to disk usage. Short-lived
lease and checkpoint delays can postpone resource reclamation.
