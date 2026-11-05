# Agent Note: Session Command Menu Space and Dismissal

Status: implemented

## Problem

A command catalog can contain enough long skill descriptions to push the input,
send action and command toggle beyond a clipped Session container. A limit based
on the browser viewport does not account for task headers, receipts, multiline
drafts or the Session's actual height. Scrolling the entire menu also moves its
header out of reach, while a keyboard-only dismissal path leaves touch users
without an accessible escape. The task detail layout also reserved only 120px
for every tab, although Session headers and input controls can require more.
Shrinking the command list alone cannot repair that ancestor constraint. The
authenticated standalone page also inherited generic content padding that
competed with the Session's own spacing and controls.

## Decision

The command menu participates in the Session's bounded flex layout. The composer,
menu and input surface can shrink with the actual container. Measured minimum
sizes preserve the menu heading, a 36px minimum catalog body, and the input's
minimum editable height, footer and errors. Reserving only the heading would
allow the catalog to collapse to zero height and leave no clickable command
area. Multiline drafts scroll inside the textarea as it shrinks; the
menu body owns catalog scrolling. Its heading, retry action and explicitly named
close control remain outside that scroll area. The heading wraps its action
group onto a separate row when needed while retaining the title's natural width.
Keyboard selection adjusts only
the menu body's scroll position and accounts for layout scaling.

For an embedded Session, measured minimum controls, Session siblings and task
Tabs determine how much height the task detail body must reserve. The visible
Session tab constrains the metadata region with that value; metadata retains its
own scrolling. Standalone Test Sessions reserve their content area's minimum
height from the same controls plus the page's return link, title, padding and
Session borders. Their topbar can shrink and scroll internally, and dedicated
content spacing overrides the authenticated shell's generic bottom padding.
Resize observers and content changes maintain the reservation on the actual
host, and deactivation or unmount releases it.

At viewport heights up to 500px, reduced vertical spacing in the composer, menu
and Session header preserves room for controls. Standalone pages also reduce
topbar, content and title spacing. This density adjustment supplements the
actual container constraints and measured minimum sizes rather than replacing
them with a viewport cap.

Dismissal changes local presentation state only. It retains the draft and never
calls a provider operation. The close button remains available when command
execution or discovery is unavailable, including pending refreshes. Explicit
close restores input focus without scrolling. A native listener on the owning
Session, or the form when no Session owner exists, consumes ordinary Escape before outer
Session and task handlers, including when focus is on the Session header. IME
Escape stops propagation while retaining its native default action. Display and
keyboard hints retain their inner-layer priority. Outside pointer dismissal
leaves focus and default behavior to the clicked target.

The [Session requirements](../../../../docs/spec/task-sessions.md#chatbox-设置命令与运行状态)
and [protocol design](../../../../docs/design/task-session-protocol.md) own the
behavior and layout mechanism. This extends the
[unified chatbox decision](2026-11-04-unified-session-chatbox.md) without changing
its shared visual boundary or the
[native control semantics](../feature/2026-10-28-chatbox-native-controls.md).

## Alternatives

**Lower the fixed or viewport-relative menu height.** A smaller cap still cannot
account for a short embedded Session, a wrapped footer or a multiline draft. It
also wastes available space in a larger Session.

**Position the menu over the timeline.** An overlay avoids adding normal-flow
height but requires separate placement and clipping constraints as the Session,
input and viewport resize. Keeping one flex layout makes the browser allocate
remaining space. Measuring intrinsic minimum controls and the metadata
reservation does not introduce another independently positioned panel.

## Consequences

Long catalogs retain a visible close action and do not displace the chatbox.
Opening a large menu can reduce the visible timeline area; closing it restores
the available layout space without changing reading or draft ownership. The
layout now couples the composer to its task detail body or standalone content
container through a scoped CSS reservation, which must be released with its
active lifetime. A
complete shrinkable ancestor chain and correct measurements remain necessary,
so geometry must be verified in embedded, fullscreen and standalone Session
surfaces. DOM-only
component tests cannot establish clipping, click reachability or scroll behavior.
