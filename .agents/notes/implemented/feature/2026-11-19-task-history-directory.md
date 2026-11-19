# Agent Note: Grouped Task History Directory

Status: implemented

## Problem

Users need to locate finished work across ordinary dependency chains and inspect
each original claim, including archives that have expired. Existing Session
directory consumers reject unknown fields, and cached retention deadlines can
become stale when a Task reopens or its dependencies change.

## Decision

Expose separate group, member and original Session pages. Each read authorizes
the current credential and Project in the same repeatable snapshot as graph and
archive selection. Cursors bind the user, Project, view, target and a digest of
directory-visible facts; changed facts require a restart. Calculate displayed
retention from current chain members and original archive facts without writing
or trusting cached deadlines. An expired tombstone remains authoritative.

The [history design](../../../../docs/design/task-session-history.md) owns routes,
fields, sort order and retention mapping.

## Alternatives

**Extend the original directory response.** Strict CLI decoders would reject the
additional fields before consumers could adopt the new capability.

**Read the old directory and enrich each row separately.** This would introduce
per-Session queries and mix claim, graph and retention observations from different
transactions.

**Persist directory groups.** This would add group maintenance to Task graph
writes and require invalidation on every relevant lifecycle transition. The
directory instead derives groups from the existing authoritative graph.

## Consequences

Older readers retain their exact response shape. New readers can distinguish
missing times, pending uploads, finalized unavailable recordings, readable partial archives and confirmed expiry
without redirecting to a newer claim. Finalized unavailable recordings retain their persisted reason; legacy receipts without a reason use `archive_unavailable`. Independent expansion pages avoid returning
an entire chain's execution history in one response.

The fact digest scans Project history metadata, and derived connected components
cost more than a simple indexed Task list. Paging bounds returned rows rather
than graph computation. A directory-visible change elsewhere in the Project can
invalidate a cursor; this conservative restart avoids mixed directory snapshots.
Session rows project only generation and end time from execution JSON, keeping
unrelated snapshot and terminal-run metadata outside the directory result.
Content bytes still use existing original-Session read admission and lifetime
management.
