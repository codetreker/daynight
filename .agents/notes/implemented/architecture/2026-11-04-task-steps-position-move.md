# Agent Note: Task Step position moves

Status: implemented

## Problem

An existing Task Step must be reorderable without changing its identity,
content or content timestamps. Relative placement can affect several rows, yet
its final order and the shared parent version must commit as one state. Repeating
an already occupied position must preserve the complete resource, even when the
parent version cannot advance. Concurrent Task writes and incomplete database or
HTTP results retain the same admission and recovery requirements as other Steps
writes.

## Decision

The [resource contract](../../../../docs/spec/daynight-task-steps.md) exposes a
position PUT with exactly one before, after or first/last placement. Placement shape and ID syntax normalize before the write transaction. After
parent/version admission, the target resolves only within the specified Task,
then canonical self-reference is rejected before resolving another anchor.
Missing targets and anchors remain distinct child absences, and no position
fallback is applied. A stale well-shaped self-anchor request still conflicts
before semantic placement checks.

A pure `MoveCandidate` copies the complete collection into its final dense order
and preserves every Step field except its internal position. Semantic comparison
recognizes adjacent relative placements, first/last boundaries and valid
singleton moves as no-ops. An unchanged result encodes the original collection
without checking version exhaustion, sampling time, updating positions or
touching the parent; stale versions still conflict before candidate comparison.

The operation reuses the neutral admission, public codec, transaction completion
and handler response facts from the
[atomic-add decision](2026-11-04-task-steps-atomic-add.md). A real move checks
exhaustion, samples database UTC microsecond time for the parent alone and
encodes the complete candidate with its new parent version before any mutation.
One affected-interval CASE UPDATE assigns final positions, followed by the narrow
parent version/time touch. The existing deferred unique position constraint
validates final order at Commit without temporary sentinel positions. All Step
content, created_at and updated_at values remain unchanged.

The [content/status change path](2026-11-04-task-steps-target-change.md) owns
content timestamp assignment and target-content persistence. Move keeps its
order candidate and interval persistence separate while reusing actual neutral
owners; it does not add a generic operation registry or another transaction
executor. The handler records `move`, changed/unchanged and the existing
independent transaction/response outcomes. Unknown completion retains the
original identity for current-fact reads without automatic replay.

## Alternatives

**Persist through the content/status change path.** That path assigns the target
updated_at and writes merged content. Reordering has a different timestamp and
persistence contract, so neutral admission/completion reuse keeps those effects
under their actual owners.

**Move rows through temporary sentinel positions.** Migration 030 already defers
position uniqueness until Commit. Assigning the final affected interval directly
uses that constraint and avoids transient positions outside the dense collection.

**Update the whole collection or rebuild the moved record.** Unaffected positions
need no writes, and rebuilding risks replacing stable identity or content times.
An immutable candidate supports complete validation while persistence remains
limited to the affected interval.

## Consequences

Moves preserve Step content and timestamps while advancing only the parent
version/time for actual order changes. The same shared-version locks serialize
moves against other Task and Steps writers. Confirmed rollback after interval
updates or parent touch restores the complete prior state; Commit ambiguity and
response loss retain their original completion classification.

Candidate construction and complete encoding remain linear in the collection;
persistence is linear in affected rows. Real PostgreSQL/HTTP tests verify dense
order, task-local placement, no-op query absence, maximum versions, concurrency,
rollback and preserved ownership. Opt-in stress tests separately verify actual
maximum-resource response bytes and a legal maximum-version no-op. Moving does
not imply workflow progression or reopen work, and no retry, history or replay
mechanism is introduced.
