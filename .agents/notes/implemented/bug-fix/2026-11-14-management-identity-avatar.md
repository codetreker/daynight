# Agent Note: Management Identity Avatars

Status: implemented

## Problem

Account and member profiles already carry a nullable avatar URL, but management
identities displayed only initials. A valid image therefore could not appear in
the account profile, member lists or their confirmation dialogs. Image loading
can fail or finish after a different user or source has replaced it, while the
surrounding interface must retain its interaction state.

## Decision

The shared management `Identity` displays the existing nonempty avatar URL
unchanged. Its avatar-local state is isolated by canonical user ID and exact
source. Loading and failure retain the existing initials, and failure removes the
image without an automatic retry. Changing the identity or source starts a new
local image lifecycle; unchanged inputs retain their state. The circular image
uses the existing 30px identity and 49px profile geometry and remains decorative.
The [Web requirements](../../../../docs/spec/daynight-web.md#管理身份展示) and
[design](../../../../docs/design/daynight-web.md) own the visible behavior and
component mechanism. The separate topbar account menu has its own avatar entry.

## Alternatives

**Remount the containing identity surface on source change.** This would reset
more than image state and could disturb a list, confirmation or account tab.
Keeping the lifecycle local isolates stale image events without replacing those
owners.

**Show the image immediately without a loading fallback.** An undecoded or
failed image can expose an empty or broken graphic. Retaining initials until
success preserves a recognizable identity and fixed geometry.

## Consequences

Valid supplied images are visible in every shared management identity; null,
empty and failed sources keep the established fallback. Source and user changes
retry independently, but the same failed source does not loop. The UI does not
alter profile data, add a new scheme policy or retry profile reads. Independent
avatar implementations, including the topbar account menu, retain their own
behavior.
