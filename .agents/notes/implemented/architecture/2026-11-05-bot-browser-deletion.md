# Agent Note: Bot deletion observation and browser history barriers

Status: implemented

## Problem

A deletion request can commit after its response is lost or after a concurrent
read still reports an active Bot. Previously started list, history and resource
reads can outlive the user's deletion action. Removing a row alone neither
proves cleanup nor prevents a retained Session from displaying old content.

## Decision

The [management coordinator](../../../../docs/design/bot-management-web.md)
retains the original deletion ID and exact version before dispatch. Unconfirmed
requests reversibly block their target; only a definite rejection followed by an
authoritative active read permits unblocking. Once any attempt is unknown, an
active read or a later rejected retry cannot prove the original attempt ended.
Explicit retries observe first and preserve the deletion identity.
Independent Session pages consult the same account coordinator before creating
clients and throughout client admission. Known Session identities include those
learned after deletion starts, so navigation to an old URL cannot bypass an
unconfirmed request by observing a still-active server snapshot.
Temporary identity checks stop new work without discarding a dispatched request's
authenticated rejection. That evidence survives until the same account can
reconcile; actual scope invalidation still discards the response. Otherwise a
known rejection becomes permanently unknown after a routine focus change.

Confirmed deletion invalidates the target's mounted and retained browser state.
The account coordinator clears target storage and display preferences even when
no page cache is attached; attached caches also discard clients and bookmarks.
The known Session identities also select independent drafts and receipts left
by old Test URLs, since those pages can close before deletion and stop observing
access. Account and Session prefixes preserve unrelated input.
Account-scope guards filter late list/detail results across page remounts. Only
both cleanup phases being completed produces a completion message; inaccessible
resources remain distinct from confirmed cleanup. Session storage preserves the
minimal request and result across reloads when available, with memory fallback.

Independent current reads have no caller-supplied mutable fence. Their
authenticated resource-conflict rejection revokes local history access, including
old Test URLs. Independent clients revalidate every three seconds, also while
reading an archive, without repeatedly downloading immutable content. Ordinary
Task conflicts and resource/operation conflicts retain their existing meaning.
The [Session design](../../../../docs/design/bot-session-view.md) owns details.

## Alternatives

**Refresh the list after DELETE.** A late pre-deletion response can restore the
row or binding. Monotonic local guards are required alongside authoritative reads.

**Clear all browser state on dispatch.** A rejected deletion would destroy unsent
input unnecessarily. Reversible blocking keeps lightweight state until access
is authoritatively revoked.

**Let page caches own all confirmed cleanup.** Navigation detaches and closes
those caches while the account request remains in flight. A later successful
response must erase saved input immediately, without waiting for another visit.

**Resume after an unknown DELETE followed by an active GET.** The write may still
be in flight, so that observation cannot prove the Bot will remain available.
The retained identity allows observation and explicit idempotent retry.

**Treat every resource conflict as deletion.** Resource and operation conflicts
also describe failures unrelated to access. Restricting this interpretation to
independent current reads preserves those callers' contracts.

## Consequences

The deleted target cannot reappear through retained clients or late management
reads, while unrelated Bot and Task data survive. Lightweight deletion records
grow with observed deletions during an account session. Independent archive
readers add periodic authority reads; a future deletion notification protocol
could reduce that cost without weakening revocation.

Storage errors prevent a guarantee of physical erasure or reload recovery.
Provider native history, exported copies and unreachable browsers remain outside
this browser contract. The implementation does not enable the complete assistant
navigation or claim real Worker/Provider integration acceptance.
