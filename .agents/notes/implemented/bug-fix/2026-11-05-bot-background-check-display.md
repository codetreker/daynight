# Agent Note: Preserve Bot Display During Background Checks

Status: implemented

## Problem

An ordinary identity check or a background read can temporarily suspend request
admission without changing the account, selected Bot or its conversation. Treating
that suspension as a loss of display identity closes open management dialogs and
hides the conversation, losing local form and reading state even when the same
information is confirmed afterward. The interface must also continue to enforce
actual deletion, access loss and uncertain writes.

## Decision

The [management page](../../../../docs/design/bot-management-web.md) separates
resource identity and displayed confirmed values from request admission. A
same-scope, same-key value remains available across a temporary pause, while
resource changes and actual failures retain their distinct handling. Dialog and
details lifetimes follow user action, selection, deletion or scope invalidation;
submission and reads still require admission.

The selected Bot's confirmed Session binding and actual display selection keep
the existing [bounded cache](../../archived/architecture/2026-11-04-bot-session-cache.md),
client and pane in place during the check. The shared client freezes input and
publication and retains its bounded transport pause; it reconnects and replays
from the cursor when the existing limits or a transport interruption require it.
The [deletion coordinator](../architecture/2026-11-05-bot-browser-deletion.md)
continues to block uncertain deletion and revoke confirmed deletion or denied
access, including late results. The [details decision](../feature/2026-11-05-bot-details-panel.md)
continues to own the shared fullscreen boundary and responsive focus behavior.

Selection-specific detail revalidation uses the separate
[current-action admission decision](../architecture/2026-11-09-bot-current-action-admission.md).
It preserves resident display without entering the authentication transport pause;
this decision continues to own retained display during feature-specific background reads.

The later [document account synchronization decision](../architecture/2026-11-11-document-account-sync.md) replaces foreground account revalidation; feature-specific visibility and resource checks retain their own lifecycles.

## Alternatives

**Hide the conversation and close dialogs whenever reads are disabled.** This
makes request admission also control presentation, so a routine check loses
unsubmitted input or disrupts reading without any change in authority or data.

**Replace the cache or client after checks.** Recreating these objects can
appear to restore the final content while discarding in-memory drafts, reading
geometry and uncertain operation ownership during the wait. The existing bounded
cache and transport recovery already own those states.

## Consequences

Unchanged checks preserve the rendered interface throughout the wait and recovery,
not only after success. Temporary admission pauses still gate business requests and publication while
feature-specific background reads continue; real resource changes, failures and
revocations retain their own semantics.
Long pauses, buffer exhaustion and actual disconnections can require a new channel;
the retained pane and client continue to own recovery and cursor replay. The
presentation guarantee does not establish current Worker availability or relax
server-side admission.
