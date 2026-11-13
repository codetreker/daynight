# Agent Note: Proposed Status Color

Status: implemented

## Problem

The pale cyan proposed background was too close to the pale green done background
for readers to distinguish neighboring tasks quickly. The same status also appears
in graph legends, task details and project statistics, so a list-only change would
leave inconsistent cues.

## Decision

Proposed uses a warm yellow background and hover, with a matching darker status
color across lists, graph status markers, details and statistics. The shared row
palette continues to provide graph backgrounds; graph borders and inspection
outlines retain their own responsibilities. Status text remains visible, and the
existing orange overdue warning retains priority. The exact palette and contrast
requirements belong to the [Web specification](../../../../docs/spec/daynight-web.md#任务条目状态背景).

The original [row palette decision](../../archived/feature/2026-10-28-task-status-backgrounds.md)
introduced full-row lifecycle cues and readable auxiliary text; the
[graph decision](../../archived/feature/2026-11-04-graph-status-backgrounds.md)
extended those backgrounds while preserving graph inspection cues. Their original
scope and rationale remain applicable.

## Alternatives

**Keep pale cyan.** Its similarity to done green makes adjacent states difficult
to scan despite their labels.

**Change only standalone rows.** Graphs, details, statistics and chain members
would still represent proposed with the older color, weakening the shared cue.

## Consequences

Proposed and done are easier to distinguish while the original labels remain an
independent cue. Default and hover backgrounds retain readable list text. Four
existing style owners must keep the proposed palette synchronized; warnings,
other statuses and interaction outlines remain independently owned.
