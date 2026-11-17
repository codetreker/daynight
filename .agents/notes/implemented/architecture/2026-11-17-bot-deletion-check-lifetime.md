# Agent Note: Bot deletion check lifetime

Status: implemented

## Problem

Independent deletion-status reads can outlive the page that initiated them. A
late unauthorized response can expire the account after navigation, while a
page must not abandon the settlement of a dispatched deletion.

## Decision

The account deletion coordinator retains the existing per-Bot operation slot
and deletion facts. Independent checks have a page-owned signal; deletion
mutations and their internal confirmation reads remain owned by the account
scope. A page retires its checks on loss of reading eligibility, immediately
releasing their slot and busy state. A new owner can replace an old check without
allowing the old response or cleanup to affect it. The signal reaches the actual
fetch and the existing unauthorized handling checks cancellation before broadcast.

The page-local hook shares one owner between automatic and manual checks and
only schedules eligible unresolved records. The
[management design](../../../../docs/design/bot-management-web.md#删除协调)
describes scheduling and operation ordering. The earlier
[browser deletion decision](2026-11-05-bot-browser-deletion.md) continues to own
the deletion identity, settlement and history barriers.

## Alternatives

**Ignore results after navigation.** The request can broadcast a 401 before a
caller discards its result, so this does not protect the new page.

**Bind all coordinator work to the page.** Cancelling an already dispatched
deletion or its confirmation would lose account-level settlement responsibility.

**Add a shared multi-consumer registry.** The current pages have mutually
exclusive owners in one window; reference counting would add coordination state
without a current consumer that needs it.

## Consequences

Cancelled reads do not publish errors or alter retained deletion facts. A real
unauthorized response from an eligible request still follows the existing account
expiry behavior. Cancellation releases client resources and does not establish
whether the server rolled back a deletion. The reported intermittent navigation
has not been reproduced, so this guarantee does not establish its sole cause.
