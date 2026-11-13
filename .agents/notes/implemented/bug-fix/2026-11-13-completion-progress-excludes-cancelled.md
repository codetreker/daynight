# Agent Note: Completion progress excludes cancelled tasks

Status: implemented

## Problem

Completion progress counted cancelled tasks as finished delivery. A Goal with
nine completed and three cancelled tasks therefore showed a full twelve-task
progress bar, despite only nine tasks having been delivered. The same progress
appeared in Goal, chain and project views, while cancellation still needed to
remain visible as a terminal outcome and satisfy dependencies.

## Decision

Web completion progress projects real counts into `done / (total - cancelled)`.
A zero denominator displays 0/0 and 0%, with an empty track. Goal and chain
tracks retain the precise ratio; overview percentages are floored. Labels and
accessible names use the same projected counts. The projection neither assigns
status nor changes actual membership, terminal counts, ordering or recent
visibility. The [semantic color standard](../process/2026-11-13-semantic-ui-color-standard.md)
uses the done color for this completion-only track. Goal details retain their
real total, completed, cancelled and unfinished statistics. The [Web requirements](../../../../docs/spec/daynight-web.md#项目整体进度)
and [design](../../../../docs/design/daynight-web.md#图投影与统计) own the
presentation and mechanism.

This partially supersedes the earlier presentation in the [cancellation decision](../feature/2026-11-06-task-cancellation-terminal.md)
and [proposed-state decision](../feature/2026-11-10-proposed-task-state.md):
`ended = done + cancelled` remains a true terminal count, not the completion
progress numerator. The archived [overview decision](../../archived/feature/2026-10-26-project-overview-progress.md)
retains the rationale for its recent window. [Goal browsing](../feature/2026-11-11-goal-browsing.md)
and [Goal detail information](../feature/2026-11-12-goal-detail-information.md)
retain their scope and statistics ownership.

## Alternatives

**Change only the Goal list.** Other views would display conflicting completion
ratios for the same tasks, so the shared projection is used at every existing
completion-progress entrance.

**Count cancelled as completed progress.** It describes terminality but implies
cancelled work was delivered. Terminality and successful completion are kept as
separate facts instead.

## Consequences

Cancelling unfinished work reduces the display denominator; changing done to
cancelled reduces both numerator and denominator. An all-cancelled scope displays
0/0 without becoming a successful result or disappearing from the recent window.
Real cancelled tasks remain accessible, including an expanded all-cancelled Goal.
Consumers must retain the real counts for status, statistics and visibility and
use the shared projection only for completion presentation.
