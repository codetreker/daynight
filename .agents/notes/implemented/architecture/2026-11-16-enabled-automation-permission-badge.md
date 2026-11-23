# Agent Note: Enabled Automation Permission Badge

Status: implemented

## Problem

Task rows and graph nodes showed both enabled and disabled automatic execution
permission, adding repeated policy text to summaries that already carry status,
execution and other metadata. Readers still need to distinguish permission from
an actual Worker claim or activity.

## Decision

The shared `TaskAgentPermissionBadge` renders only when the Task's
`allowAgents` is true. Ordinary rows use the full localized automatic execution
label; compact graph nodes use a short label with the full accessible name and
tooltip. The badge uses the done-green background, border and text tokens. It
indicates permission alone and does not change task lifecycle, Worker or Session
presentation. The detail switch retains its independent controls and write
contract. The [Web requirements](../../../../docs/spec/daynight-web.md#自动执行许可与平台要求)
and [design](../../../../docs/design/daynight-web.md#自动执行许可与确认) own
those behaviors, and the [Web visual tokens](../../../../docs/design/web-visual-tokens.md#任务状态与交互色)
own the palette.

This partially supersedes the neutral on/off permission presentation in the
[shared Task color roles decision](2026-11-13-shared-task-color-roles.md); its
other color roles and original rationale remain applicable.

## Alternatives

**Keep the neutral on/off label.** Explicitly displaying both values separates
permission from execution, but adds a disabled-policy label to every affected
row and graph node. Showing only enabled permission reduces that noise while the
text and separate Worker indicators retain the distinction.

## Consequences

All shared ordinary rows and graph nodes use one rendering rule. A disabled
permission leaves no badge or reserved space; changes to the confirmed value
add or remove the badge without a separate business write. The green badge
shares a palette with completion, so its label and independent status and Worker
indicators remain necessary to convey its actual meaning.
