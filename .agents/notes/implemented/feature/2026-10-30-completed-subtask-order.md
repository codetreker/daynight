# Agent Note: Completed Subtask Ordering

Status: implemented

## Problem

Creation order does not tell a reader which child of an expanded task chain
finished most recently. Completed tasks may finish in a different order from
their creation, and refreshing a task can preserve an older completion position.

## Decision

Expanded chain children keep the status priority `in_progress`, `todo`, `done`.
Within `done`, known `completedAt` values sort descending at nanosecond precision
using the existing timestamp conversion. Unknown completion times follow known
times. Equal times and pairs of unknown times preserve full snapshot order;
other status groups retain snapshot order. A refreshed index recalculates the
list while preserving the mounted chain's disclosure state.

This partially supersedes the within-status snapshot-order choice in the
[Goal list decision](2026-10-26-goal-task-lists.md). The
[project status decision](../bug-fix/2026-10-28-project-status-order.md) continues
to own top-level ordering. Required behavior belongs in
[W5](../../../../docs/spec/daynight-web.md); list composition belongs in the
[Web design](../../../../docs/design/daynight-web.md).

## Alternatives

**Keep snapshot order for completed children.** This avoids another time
comparison but leaves recent completions mixed with older completed work.

**Compare JavaScript Date values.** Millisecond precision would merge distinct
completion times already available in the service timestamp. The existing
nanosecond conversion preserves that distinction without a new time parser.

## Consequences

Recent completed work appears first within the completed group. Missing times
remain visible without inventing completion dates. Timestamp changes can move a
completed child on refresh. Membership, top-level ordering, graph projection,
layout, preferences and API contracts keep their existing responsibilities.
