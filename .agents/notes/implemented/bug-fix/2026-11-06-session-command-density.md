# Agent Note: Session Command Description Density

Status: implemented

## Problem

Native skill catalogs include long descriptions and can repeat the same argument
hint on every row. Expanding all of that text makes a mobile command menu show
only a few choices at a time, even when its container and scrolling work
correctly. Changing row height during browsing can also move the intended target
away from the pointer. Reducing visible text must preserve access to the full
description and the existing command selection behavior.

## Decision

The shared composer clamps inactive descriptions to two lines and expands the
single highlighted row. Full descriptions remain in the DOM and in each option's
accessible name. Only the highlighted row renders its argument hint. Provider
catalog descriptors remain unchanged: `argumentHint` also controls whether
selection completes a command head for argument input instead of executing it.

Mouse and pen movement change the same highlight used by keyboard navigation.
Pointer highlighting preserves the target's position relative to the catalog body
by compensating its scroll position after row heights change. At the start or
end of the scroll range, temporary list padding supplies only the space needed
to retain that position. Each new pointer anchor replaces the previous padding;
keyboard navigation and input, catalog or menu lifetime resets remove it. Native
scroll anchoring is disabled for that body so it cannot apply a second compensation.
Stationary pointer coordinates do not trigger another highlight change as rows
move. Moving over an already highlighted row also enters pointer browsing, so
resize observation cannot force keyboard reveal while the user scrolls its
description. Arrow navigation restores the existing body-only reveal behavior. Touch does not enter the hover path,
and hover does not establish explicit keyboard candidate selection.

The [requirements](../../../../docs/spec/task-sessions.md#chatbox-设置命令与运行状态)
and [design](../../../../docs/design/task-session-protocol.md) own the complete
behavior. This complements the
[menu space and dismissal decision](../../archived/bug-fix/2026-11-04-session-command-menu.md) and
[slash submission decision](2026-11-05-session-slash-submission.md): menu height,
catalog discovery, filtering, availability and command dispatch retain their
existing owners.

## Alternatives

**Remove the generic hint from the Codex catalog.** This would reduce repeated
text but also remove the signal that makes selecting a skill complete its
command head. Keeping the data and restricting presentation avoids changing
execution semantics or the protocol.

**Reveal every highlighted row through the keyboard scroll path.** Expanding a
long row under the pointer can scroll its top into view and displace the target.
Preserving the pointer's target position permits reading the expanded content
without replacing the keyboard navigation rule.

**Compensate with scroll position alone.** Browsers clamp `scrollTop` to the
available range. If row contraction requires a negative position or one beyond
the new maximum, compensation alone still displaces the pointer target. Temporary
space at the affected edge preserves the position without reserving permanent
blank space throughout the catalog.

## Consequences

Compact rows leave more room to compare commands while the active description
remains readable. A highlighted description can still exceed the visible list
height and requires scrolling; the menu's existing size allocation remains
unchanged. Pointer browsing near a scroll boundary can temporarily show extra
space; this trades edge density for a stable target and disappears when keyboard
navigation or catalog reset takes over. Pointer anchoring adds local geometry
state and must remain distinct from command intent. Browser checks must exercise
real row expansion at both scroll boundaries, manual scrolling, keyboard
transitions and narrow widths because DOM-only tests do not establish clipping
or scroll stability.
