# Agent Note: Space activation for the task popout menu link

Status: implemented

## Problem

The task detail menu focuses a native link declared as a menu item. Enter
activates it, but Space does nothing: the ARIA role does not supply the keyboard
behavior users expect from the adjacent menu buttons.

## Decision

`TaskDetailActions` prevents the default Space keydown on its popout anchor,
arms activation for a nonrepeated press, and activates the existing click path
on release. Losing link focus cancels the pending activation. That path
closes the menu and restores trigger focus. Enter and mouse activation retain
browser defaults, including modified and middle clicks, the actual URL, `_blank`
and `noopener noreferrer`. Button menu items retain native keyboard activation.

This completes the keyboard behavior of the native link established by the
[standalone detail decision](../../archived/architecture/2026-10-24-standalone-task-detail.md).

## Alternatives

**Activate on keydown.** Restoring trigger focus before release sends subsequent
repeated Space events to the native button, which can reopen the menu on keyup.
Activating on release keeps the entire held key gesture on the link.

**Handle Space on the entire menu.** Simulating clicks for buttons as well as
links would overlap native button activation and risk duplicate operations.
The handler therefore belongs to the anchor that lacks Space activation.

## Consequences

Space opens one tab per nonrepeated activation without replacing native link
semantics. A standalone detail without a popout link installs no Space handler.
Component tests check repeat suppression and the click/close path; browser
tests verify actual tabs, URL, opener isolation and focus after keyboard and
mouse activation.
