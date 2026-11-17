# Agent Note: Disable Sole App Administrator Removal

Status: implemented

## Problem

The App administrator list offered removal when its complete roster contained only one member. Opening a dialog with no confirmation action made the available action misleading.

## Decision

The row's native disabled state uses the existing complete-roster `singleAdmin` check and the shared button styling. Invitations do not count as administrators, and a page with a continuation cursor does not establish a sole administrator. The [administration design](../../../../docs/design/github-app-administration.md) describes the resulting behavior.

## Alternatives

**Keep the dialog as the only guard.** It explains the restriction after activation but offers an action that cannot be completed.

**Rely solely on the client count.** The roster can become stale, so the server's serialized `last_admin` decision remains authoritative.

## Consequences

The existing hint remains visible and the disabled control cannot be activated by pointer or keyboard. A refreshed roster can change availability; concurrent changes can still produce a server refusal. No additional count request or persisted state is needed.
