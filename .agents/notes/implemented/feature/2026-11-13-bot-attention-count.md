# Agent Note: Assistant attention counts

Status: implemented

## Problem

Assistant conversations contain both routine records and matters requiring user
attention. A message unread count would give routine success records the same
weight as unresolved decisions. Opening a conversation must acknowledge reports
without hiding manual revision proposals that still need a user decision.

## Decision

The [management specification](../../../../docs/spec/bot-management-web.md#关注标记)
defines the attention badge. Bot reads project unseen attention events and pending
proposals separately. Proposal notification events are excluded from the event
sum: the proposal resource remains authoritative through viewing, transfer and
the eventual decision. Counts follow the current task holder, including expired
claims and paused tasks, and omit deleted tasks.

The Bot attention endpoint reuses the assistant-task module's owner-scoped
transactional clear operation. Event delivery and user viewing remain independent.
The browser acknowledges the selected conversation only after its current identity
is confirmed, then rereads the count instead of assigning zero. Cached panes and
background list reads do not acknowledge other conversations. A confirmed opening
with zero attention consumes the same allowance without a write, so later polling
cannot acknowledge reports that arrived after that opening.

Bot HTTP responses expose the count only when the caller requests
`Daynight-Bot-Attention: 1`; the server echoes that capability. Existing strict
CLI clients retain their original response shape, including creation and
original-ID recovery. The current CLI parser accepts a missing count and validates
the field when present. The website requests and requires the count projection. The root CORS adapter
recognizes POST on the exact seen route while keeping unsupported methods and
other methodless fallbacks closed; preflight never invokes acknowledgement.

## Alternatives

**Count proposal notifications with ordinary events.** This would count the same
proposal twice when combined with pending proposals, or lose the reminder after
viewing when used alone. Querying the proposal's pending state preserves the
decision requirement without coupling it to delivery state.

**Clear the displayed count optimistically.** A successful viewing acknowledgement
does not decide pending proposals, and new events can arrive concurrently. An
authoritative read preserves both facts and exposes failed reads without claiming
that attention has disappeared.

**Add the field unconditionally and update only the current CLI parser.** Already
installed strict clients would still reject list, show and successful creation
responses. Negotiation preserves their behavior without requiring a coordinated
CLI release.

## Consequences

The existing event schema and clearing transaction need no migration. List and
detail reads now include aggregate queries over assistant-task events and
proposals; their cost follows the indexed target and task relationships. The
badge represents persisted business attention rather than native message activity.
Unknown write results remain visible and are not automatically replayed. Event
production and native delivery retain their existing owners.
