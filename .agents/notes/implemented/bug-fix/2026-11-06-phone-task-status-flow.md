# Agent Note: Phone Task Status Flow

Status: implemented

## Problem

Task details have little vertical space on phones. Nested wrapping groups and
a full-width status/assignee group split short controls across four lines,
leaving less room for descriptions and attachments. Compact controls should use
available row space without hiding labels or losing locked-control explanations.

## Decision

At viewport widths up to 600px, the badges and state-controls wrappers use
`display: contents`. Their children participate in the status row's wrapping
flex layout with 6px row gaps and 4px column gaps. The row extends 8px into
each side of the heading padding, giving controls more horizontal space while
leaving the title, reading panels, pause control and claim summary untouched.
Status and assignee retain their compact pair and
existing name ellipsis, but the pair no longer requests a complete line.
The platform select uses the compact, content-width shared native control;
its wrapper can shrink within the row and its arrow spacing belongs to the
[shared selection decision](../architecture/2026-11-14-shared-native-select.md).
Automatic execution retains its nonshrinking label/switch combination and
automatic left margin, placing it at the right edge of the final line.

Only presentation wrappers lose their boxes. Platform and automation tooltip
wrappers retain their boxes, positioning and focus behavior. DOM order is
unchanged, so keyboard traversal follows status, assignee, platform and
automatic execution. The shared detail surface applies this layout to dialogs,
standalone pages and fullscreen; desktop layout and short-height compact rules
retain their existing responsibilities. Pause controls and claim summaries
remain outside the status row.

This extends the [compact header decision](../../archived/simplification/2026-10-24-compact-task-detail-header.md)
and the [fullscreen decision](../../archived/feature/2026-10-25-task-detail-fullscreen.md).
The [automation decision](../../archived/architecture/2026-10-23-task-agent-automation.md)
and [platform control decision](../../archived/simplification/2026-10-24-task-platform-confirmation-control.md)
record the rationale for the existing confirmation and mutation ownership. The [Web requirements](../../../../docs/spec/daynight-web.md)
own row limits; the [Web design](../../../../docs/design/daynight-web.md)
owns current component layout.

## Alternatives

**Remove only the full-width basis of the status/assignee pair.** The enclosing
groups would still wrap independently from automatic execution, reserving unused
horizontal space and forcing additional lines.

**Keep the native select sized to its longest option.** English phone dialogs
cannot fit the ordered controls into two lines with that extra width. Sizing to
the selected option preserves its complete label and the native option list.

**Flatten the component markup at every width.** It would change the existing
desktop grouping and require reconstructing it there. Restricting box flattening
to the phone media query preserves component and interaction ownership.

## Consequences

Reading panels receive the space freed by fewer status lines. The two decorative
wrappers have no geometry on phones; layout checks must measure the real controls
and badges, including nonoverlap, visual order and final right alignment.
Long names remain truncated according to the existing name limits. Localization
and future controls can change wrapping, so browser checks retain phone widths
and both languages rather than assuming that compact controls always fit.

The original platform control used `field-sizing: content` and the browser's
arrow to minimize its selected-option width. The shared control now reserves a
consistent arrow inset, so a narrow row can wrap differently while retaining the
native option list and the row's layout rules.
