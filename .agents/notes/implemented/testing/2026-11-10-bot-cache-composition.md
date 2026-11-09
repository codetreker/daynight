# Agent Note: Verify Bot Cache Composition at Its Real Owners

Status: implemented

## Problem

Independent action-admission and snapshot-store tests cannot establish that the
assistant page connects their guarantees correctly. Page selection must revoke
old callbacks before a React commit, while an existing operation can still
receive its original receipt. Persistent recovery also depends on browser
scrolling, native storage events and locks that a simulated store cannot prove.

## Decision

The production `BotsPage`, cache and Session client run together in the hot-switch
component suite. Each remote write entrance is called before the navigation
commit and during returning-detail revalidation. Assertions preserve operation,
submission and setting state and require zero new IDs or commands. An explicit
call after confirmation is the positive control. A separate unknown-operation
case queries the original receipt through the visible recovery control while
the returning detail remains pending and a newer draft remains editable.

The assistant browser runner includes a cache-composition suite using the
production application, observer, store, client and renderer with controlled
HTTP and Session API responses. The existing persistent transport uses the same
entry identities for its tail and older pages. Explicit history barriers and
channel events exercise preview handoff, real pagination, Latest cancellation,
revisions, appends, authoritative empty history and execution replacement.

Seven normally visited targets exercise the three resident panes and six
persistent histories together. Two same-origin pages hold real Web Locks and
observe their pending queue before revoking access. Native storage events and
persisted readback detect an old queued payload reaching disk or a cold read
recovering cleared private history. These cases extend the existing
[persistent-history mechanism](../architecture/2026-11-09-bot-persistent-history-preview.md)
without introducing a second cache or reproducing its complete store matrix.

## Alternatives

**Repeat every store and client case in a browser.** Most protocol refusals,
quota failures and identity permutations have deterministic module owners.
Repeating that matrix adds browser preparation and timing costs without proving
a different mechanism. Browsers own the DOM, scrolling, persistence and native
cross-tab coordination needed by the combined behavior.

**Use manually seeded snapshots or a simulated lock.** These can isolate store
rules but cannot show that accepted client history reaches persistent storage,
survives a new document and remains fenced by the browser's real lock queue.

**Start a Provider for frontend races.** Provider execution cannot deterministically
hold a detail response or browser storage lock. The existing Linux product E2E
retains its representative normal flow; native Provider acceptance remains a
separate evidence boundary.

## Consequences

The new browser cases run through the existing assistant configuration and its
CI job, with one worker and zero retries. They add a small set of composed
proofs while keeping local mechanism matrices in their existing tests.
Controlled responses establish frontend consumption, not real Worker or
Provider execution. Narrow viewports and synthetic keyboard geometry do not
establish physical phone behavior. Results remain bound to their actual source,
browser and execution environment.
