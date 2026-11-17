# Agent Note: Account Reading History

Status: implemented

## Problem

Account tab selection lived only in the component. Browser Back and Forward
could not revisit the profile, credentials and prompt views in their reading
order, even though changing tabs preserves sensitive operation and editor owners.

## Decision

The original decision used the existing navigation owner to record an entry
identity and a lightweight, identity-bound selection with the history marker.
Account consumed its admitted selection, initializing an active controlled entry
by replacement and pushing changes through the draft admission gate. This made
same-URL entries publish distinct snapshots while retaining credential and prompt
owners independently of the entry identity. The later [account tab URL decision](2026-11-17-account-tab-urls.md)
replaces that account-specific selection with URL routing to support sharing and
cold entry. Worker detail continues to use a Worker-bound history selection; its editing owners remain
mounted after opening and cancellation restores the appropriate dirty tab only
after the original history position is admitted. The
[peer-tab decision](../architecture/2026-11-12-worker-detail-prompt-tab.md)
extends that selection to the Worker prompt. Invalid recognized state is exposed
rather than interpreted as another target. Project
uses the same entry model for section, view, graph and nested resource selections;
its existing preference writes occur only after user-initiated changes are admitted.

The [Web design](../../../../docs/design/daynight-web.md) owns the current
consumer and the [navigation design](../../../../docs/design/daynight-task-steps.md#web-呈现导航与大集合)
retains the indexed and native-history boundaries. The earlier
[admission decision](../../archived/architecture/2026-11-04-draft-navigation-admission.md)
explains the existing protection; the [invitation decision](../bug-fix/2026-11-04-invitation-history-state.md)
continues to prohibit serializing URLs and invitation credentials.

## Alternatives

**Encode every selection in the URL.** This would change sharing and cold-entry
semantics and require authentication handoff beyond the requested local reading
history.

**Keep selections only in the component.** This preserves local editing but cannot
restore each browser history entry or distinguish visits to the same URL.

## Consequences

Back and Forward restore lightweight reading selections without replaying user
operations. Browser state does not hold drafts, secrets, responses or DOM; data,
authority and operation lifetimes stay with their existing owners. State from
another document is not a cross-refresh restoration contract, and unnumbered
native history retains the existing limitations of draft admission.
