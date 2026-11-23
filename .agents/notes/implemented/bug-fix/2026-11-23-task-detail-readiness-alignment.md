# Agent Note: Task Detail Readiness Alignment

Status: implemented

## Problem

Ordinary Task details present readiness next to compact status, assignee,
platform and automatic execution controls. The ready and blocked badges use a
larger size and taller padded line box than these adjacent controls. Aligning
the two status-row groups at their tops leaves the badge and switch centers
visibly offset, with a larger difference when browser font preferences increase.
The same shared header appears in dialogs, standalone pages and fullscreen.

## Decision

The ready and blocked detail badges select `--text-xs`, matching the compact
controls and execution labels. Their line boxes have a 24px minimum height,
unitless 1.5 line height and no vertical padding, so enlarged text can grow the
box naturally. Confirmation-dialog lifecycle badges retain their own typography
and padding; badge color, weight and the todo-only readiness rule are unchanged.

The shared status row centers its actual same-row content on the cross axis.
The local compact-platform wrapper uses that alignment, and the status-trigger
wrapper uses a flex box so inline baseline space cannot offset the control.
The left group retains its order; when content no longer fits, automatic
execution wraps as one complete right-aligned combination without appearing
between lines of the left group. The existing flattened flow at widths up to
600px and short-height fullscreen constraints continue to apply.

This supersedes only the top-alignment choice recorded in the archived
[automation permission decision](../../archived/architecture/2026-10-23-task-agent-automation.md).
That choice originally kept the right-side operation anchored to the first
status line while the left group wrapped independently. Actual same-row
centering preserves a consistent control center as text grows. The
[phone status flow](2026-11-06-phone-task-status-flow.md),
[control font](2026-11-20-task-detail-control-font.md) and
[execution label](2026-11-20-task-execution-label-size.md) decisions retain their
respective layout and size responsibilities. The
[Web requirements](../../../../docs/spec/daynight-web.md) and
[Web design](../../../../docs/design/daynight-web.md) own current behavior and
mechanisms.

## Alternatives

**Keep the shared lifecycle-badge rule.** Its larger text and vertical padding
make readiness taller than neighboring compact controls. Changing that shared
rule would also alter confirmation-dialog lifecycle states.

**Offset the badge or constrain it to a fixed-height box.** An offset compensates
for only one font size, while a fixed height can clip enlarged text. Natural line
boxes and cross-axis alignment preserve browser font preferences.

**Flatten all status-row wrappers at every width.** This would allow automatic
execution to occupy a gap among lines of the left group, losing the desktop
grouping. Flattening remains limited to the existing phone layout.

## Consequences

Readiness and adjacent compact controls scale together across all ordinary
Task detail presentations. Browser regression checks measure both readiness
states, same-line center alignment, and wrapping with long assignees and enlarged
text. Multiline groups have no single control center to compare; geometry checks
compare actual controls on the same visible line and preserve nonoverlap and
right alignment after wrapping.

Task lists, graph nodes, Goal details, confirmation behavior and mutation
ownership keep their existing responsibilities. The 24px minimum is a compact
baseline, not a maximum or a fixed clipping height.
