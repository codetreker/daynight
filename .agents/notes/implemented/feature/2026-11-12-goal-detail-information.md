# Agent Note: Goal Detail Information

Status: implemented

## Problem

Goal readers need the complete resource identifier for CLI references and
collaboration, creation and modification times, and a concise view of the work
owned by the Goal. The project Goal list already exposes its child tasks and
chains; repeating that list in detail splits task browsing across two owners and
occupies space beside the Goal's description.

## Decision

Goal detail provides Description, Attachments and Discussion, with Description
selected by default. `GoalInformation` sits beside the Markdown description on
desktop and follows it on narrow screens. General information begins with the
complete, selectable Goal ID and a localized copy icon. The shared
`TaskCopyButton`, keyed by Goal ID, owns clipboard pending, success, failure and
late-result isolation; Goal-specific labels distinguish this identifier from a
Task ID. The Goal frame owns its `TaskDetailNotifications` host and heading focus
fallback, preserving notification placement, dismissal and expiry without moving
the aside. Nested Task and chain portals retain their own notification and
overlay owners. Copy is a reading action independent of Goal state, edit
permission and child statistics; resource admission still governs availability.
The aside also reads the Goal's own timestamps from complete detail and its
standalone, chain and progress counts from the existing Parent scope of the
complete ordinary graph. Cancelled work remains
distinct from successful completion in the real statistics. The [completion-progress decision](../bug-fix/2026-11-13-completion-progress-excludes-cancelled.md)
excludes cancelled from the separate progress display. Missing graph data is a loading state;
refresh failure retains displayed statistics and its retry action. The Goal
resource retains its own exact completion time in the common metadata row,
independently of the child progress and the description aside timestamps.

Child rows and chain disclosures belong to the project Goal list. Goal detail
retains controlled nested graph and Task reading owners for history restoration.
Details selects a cross-Goal destination and its child Task together. External
Expand selects that Goal and its complete chain graph for a multi-member target,
or Task details for a single member. Standalone unparented chain expansion passes
a transient project graph witness. These choices preserve each action's reading
intent without a detail list or focus witness.
Description, attachment and discussion panels retain their mounted state. The
Goal frame registers its overlay before mounting graph and Task portals, so a
combined Goal and child selection has the correct parent from its first render.
The existing resource, draft, history and overlay admission still applies.

This replaces the Task panel presentation adopted by the
[Goal description tab decision](2026-11-12-goal-description-tab.md) and the
[Goal Task entrance decision](../simplification/2026-11-12-goal-task-entrances.md).
The [Goal browsing decision](2026-11-11-goal-browsing.md) continues to own complete
graph classification and scoped list navigation. The
[Goal requirements](../../../../docs/spec/daynight-goals.md) own the visible
fields and the [Web design](../../../../docs/design/daynight-web.md) owns their
composition and lifecycle.

## Alternatives

**Keep child tasks in a renamed Description panel.** This would remove the Task
tab label while retaining the duplicate list and its expansion state in detail.
The outer Goal list already provides those browsing controls.

**Reuse TaskId directly.** Its labels identify a Task, so using it for a Goal
would misname the accessible action and clipboard failure. Reusing the clipboard
button and notification host preserves their behavior while letting Goal detail
own the resource-specific text.

## Consequences

The description has a stable information aside and task browsing has one visible
list owner. ID copy and statistics require no new API or cache. A full UUID must
wrap on narrow screens while leaving the button reachable, and clipboard failure
must retain selectable text and a retry path. Existing nested reading
history remains useful, but cross-Goal navigation must supply the intended child
or graph selection directly because detail no longer has a row to locate or
focus. Details and graph expansion therefore use distinct navigation callbacks.
