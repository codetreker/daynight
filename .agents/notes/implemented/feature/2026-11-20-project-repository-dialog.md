# Agent Note: Project Repository Editing Dialog

Status: implemented

## Problem

The repository address is useful to all Project members, but an always-visible
editing form competes with the current address and other management actions.
Changing a repository also requires a review of effects before a write.

## Decision

The address card shows the current value and an authorized administrator's Edit
action. One shared management dialog hosts both the draft and its preview, with
return to editing invalidating the preview. Closing retains the same user's
Project draft and reopening requires a fresh preview. The existing repository
switch protocol and its guarded, unknown-result behavior remain in the
[repository switching decision](../architecture/2026-11-19-project-repository-switch.md).
The [settings specification](../../../../docs/spec/project-settings.md#仓库地址)
owns the interaction contract.

## Alternatives

**Keep the form in the card.** The input and preview action occupy management
space even when a user only needs to read the current address. A dialog gives
the editing and impact review a bounded focus without removing that read surface.

## Consequences

The card remains readable to members while administrators use the existing
modal focus and suspension behavior. Draft and preview lifetimes are distinct:
canceling preserves input, but an earlier preview cannot authorize a later edit.
