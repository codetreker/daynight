# Agent Note: Index member pages and terminal pending operations

Status: implemented

## Problem

Member pages can scan and sort a large Team membership set, while terminal
expiry and queue reads can examine a long completed operation history even when
no operation is pending. These reads need access paths suited to their filters
without changing pagination, state transitions or concurrency guarantees.

## Decision

The non-unique B-tree `team_members_team_created` indexes `(team_id, created_at)`.
Member pages retain the complete `(created_at, user_id)` ordering and cursor;
the index has exactly two keys and does not itself order equal timestamps by
user ID. The partial non-unique B-tree `session_operations_terminal_pending`
indexes `(session_id, operation_seq)` only for receipt states `queued` and
`dispatching`. The accepted-only `session_operations_pending` remains for Web
Session reads. Existing primary and unique indexes and `team_members_user` remain.

## Alternatives

**Add `user_id` to the member index.** A three-key index can provide the full
page order, but the confirmed choice retains only the two keys and accepts any
remaining sort. The query and composite cursor still resolve equal timestamps.

**Index terminal deadlines or impose a uniqueness constraint.** Neither is
needed for the selected pending subset access path; each adds a separate storage
or business guarantee beyond these reads.

## Consequences

Both indexes require storage and maintenance on writes. PostgreSQL may choose
other plans, filter rows or add a sort depending on statistics and parameters;
the two-key member index does not guarantee a fully ordered scan. The terminal
partial index excludes completed history and does not alter operation ordering,
expiry, locking or authorization. Schema snapshot and migration tests verify
the same index definitions on fresh and upgraded databases.
