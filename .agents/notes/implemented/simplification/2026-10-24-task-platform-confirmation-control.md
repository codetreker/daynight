# Agent Note: Confirmed Platform Control in Task Status

Status: implemented

## Problem

A task's platform requirement appears in its status row while changing it
requires a separate Overview editor and Save action. The two locations split
one field's display and operation, consume reading space and make the editing
entry unavailable while reading attachments. Changing the allocation must keep
version review, deliberate submission, request ownership and keyboard access.

## Decision

Task details use one compact select immediately after the status menu in the
left status group for the confirmed platform and its operation. Both controls
use a 24px height; readiness follows the pair. The select offers Any platform,
Windows, Linux and macOS; Any platform represents the existing null requirement. The former detail badge
and Overview editor are removed. List and graph platform badges stay read-only.
The control remains available on either detail tab. The left group can wrap at
narrow widths while the automatic-execution control remains right aligned with
the first status line.

Choosing the saved value does nothing. A different selection opens confirmation
showing the current and target platforms, retaining the confirmed select value.
The confirmation captures the complete reviewed task and target requirement;
known identity, content or version changes invalidate it. Confirm submits once
with the captured exact version. Cancel, Escape, close and backdrop dismissal
preserve the saved value and restore focus to the connected, enabled select;
if the opener is no longer usable, focus returns to the task title.

`TaskDetailDialog` owns one discriminated confirmation state for status,
automatic-execution permission and platform. The shared `TaskConfirmation`
provides the modal shell, focus trap and inert parent. Its existing optional
content slot accommodates the platform transition, as it does the status change
and timing effects. This keeps deliberate selection local while the
existing task session continues to own submitted operations after confirmation
or detail closure. Pending, unknown and reconciliation states still block other
writes; in-progress tasks lock the control. Only a confirmed successful response
changes its displayed value. Refusal retains saved state, conflict requires a
fresh decision, and uncertain outcomes require reading the actual task without
replaying the write.

This supersedes only the explicit-Save UI allocation in the
[platform requirement decision](../feature/2026-10-24-task-required-platform.md).
That decision retains the original field, migration, domain, filtering and
version semantics. The [automation decision](../architecture/2026-10-23-task-agent-automation.md)
retains permission semantics, while the [compact-header decision](2026-10-24-compact-task-detail-header.md)
retains title and reading-space allocation. The [Web requirements](../../../../docs/spec/daynight-web.md)
and [design](../../../../docs/design/daynight-web.md#平台要求与确认下拉框) own the complete visible and request behavior.

## Alternatives

**Keep the separate Overview editor and Save action.** Its explicit action makes
it clear when a draft becomes a request, but the status badge and lower editor
remain two locations for the same requirement. It also consumes Overview space
and requires leaving attachments to edit the field. A confirmed status-row
control retains deliberate submission while giving the field one entry.

**Submit immediately when the selected option changes.** It removes the lower
Save action, but native keyboard or pointer selection would become a mutation
without review of the current-to-target transition. Confirmation gives that
review and preserves zero-write dismissal without a second persistent control.

## Consequences

Platform display and editing use one location without adding an API, task field
or mutation owner. The modal's opener restoration supports select controls as
well as the existing button entries. Bilingual labels, long task titles, narrow
layouts and both detail tabs remain part of validation, alongside cancellation,
shared locks, stale review and late-response ownership.

The platform continues to describe task requirements rather than a current
machine or active worker. This allocation does not change automatic eligibility,
explicit manual status setting, backend execution locks, worker ownership or recovery. Those
mechanisms retain their existing owners and evidence requirements.
