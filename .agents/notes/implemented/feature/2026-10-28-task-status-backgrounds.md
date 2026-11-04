# Agent Note: Task Status Backgrounds

Status: implemented

## Problem

Overview and task-list rows use the same neutral background despite different
lifecycle states. Small status labels require readers to inspect each row, and
the overview navigation highlight can obscure a row's lifecycle cue. Existing
muted text colors also lack sufficient contrast on darker hover backgrounds.

## Decision

Overview progress rows, standalone rows, chain headers and child rows share a
row-scoped palette. The full row uses gray for todo, blue for in_progress and
green for done, with darker same-hue hover colors. Text remains visible; completed
rows retain full opacity. Auxiliary text uses a darker shared color to meet the
4.5:1 text contrast requirement on default and hover backgrounds. Status labels
within these rows retain their text and use the palette's darker status colors.
The original row delivery left graph cards and task details outside its scope.
The [graph background decision](2026-11-04-graph-status-backgrounds.md) extends
the shared palette to graph cards; task details retain their own styles.

Task rows use their own status. Chain headers and overview chain rows use the
existing ordinary-component aggregate, including completed members and excluding
external prerequisites. A partly completed chain remains in progress even with
no executing member. The standalone overview aggregate uses its current counting
window: all unfinished members plus eligible recent completions. Its lifecycle
cue changes when the last eligible completion expires, using the existing
overview deadline rather than a new timer. The
[recent-task decision](2026-10-27-recent-task-pages.md) retains ownership of
membership, local-calendar completion windows and display conditions. The
existing aggregate status also covers a recent set containing only completed
members, so its row is green at 100%.

Existing standalone overdue warnings override the lifecycle background with
amber while retaining the in-progress label. Warnings do not spread to aggregate
rows or add overdue presentation to child tasks. Purple focus and navigation
outlines remain independent of lifecycle backgrounds. Expanded child containers
stay neutral so each member's state remains distinguishable.

Required behavior and colors belong to the
[Web specification](../../../../docs/spec/daynight-web.md#任务条目状态背景);
the [Web design](../../../../docs/design/daynight-web.md) owns composition.

## Alternatives

**Reuse the global graph status palette.** At the original row delivery, those
selectors also owned graph-card presentation outside the delivery scope. A
row-specific attribute and stylesheet allowed the browsing palette and text
contrast to change independently. Graph cards now consume its background
variables under the graph background decision while retaining graph borders
and text styles.

**Infer aggregate state from executing count.** A chain with completed and todo
members but no running member would appear todo, contradicting existing chain
semantics. The cached component state remains authoritative.

**Count every historical completion for the standalone background.** That would
let tasks excluded from the visible aggregate turn its background blue. Using
the same window as the displayed counts preserves a consistent explanation.

## Consequences

The palette gives whole-row status cues without introducing API fields or
lifecycle states. The standalone aggregate can change color as recent work ages
out, even without a new snapshot. Regression checks must cover that boundary,
mixed-state chains, warning priority, computed browser styles, focus/navigation
outlines and narrow layouts. Graph cards share the palette without adopting
list typography or borders. Pagination, compact layout, graph canvases and
task-detail presentation retain their independent owners.
