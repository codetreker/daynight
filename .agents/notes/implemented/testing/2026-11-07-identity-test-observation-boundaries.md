# Agent Note: Identity integration test observations

Status: implemented

## Problem

Authenticated-shell and Team-navigation tests repeatedly wait for request counts
and stored selection changes that do not mutate the DOM. The default 50ms DOM
sampling interval adds idle time between those observations. A readiness loop
that repeatedly yields and catches semantic-query errors also spends work
rediscovering a presentation before its cache and identity operations complete.
Cached task content and a disabled control cannot identify which opening's live
read has been admitted while an independent pending write retains its lock. Broad
status-button discovery also repeats synchronous DOM work while live cache
admission and reconciliation still need to progress.

## Decision

Pure request, request-body and storage predicates use the existing
`packages/daynight-web/tests/helpers/waitForState.ts`. Rendered-control and mixed
state/presentation predicates retain React Testing Library's DOM waiter. The
original immediate checks, explicit options, failure budgets, real transport,
IndexedDB operations and reader ownership remain in force.

The identity-eviction fixture observes the real Alice and Bob cache-commit
promises. Authentication is committed before its project synchronization is
awaited. With only production intervals virtualized, the sync response's actual
principal inspection is observed before React's identity-recovery dispatch is
awaited. These receipts retain the original five-second observation bound;
response contents, request signals and the real operations are unchanged. The
existing private-content checks still run before the held identity response is
resolved, including the presentation captured at recovery dispatch.

The pending-status navigation fixture observes the real session through its
existing opening method without adding a subscriber. It identifies a task GET
after the later opening, then jointly checks fresh ready state for that live
version and the still-visible, still-disabled control. The pending request must
remain un-aborted and unique. Only then is its held response resolved. A fresh
read does not settle the independent retired write or authorize another write.
After its response is resolved, one DOM-readiness predicate first checks the
matching cache summary and fresh live detail, then queries the actual status
picker for the visible, enabled control. The original readiness deadline is not
extended; state sampling avoids repeated broad semantic-query work while real
I/O is still pending.

Navigation and token queries use their actual current owners. Stable Team menu
phases retain exact visible radio order and identity, accessible names,
visibility, focus and the original global absence and request-count checks.
Mutable fixtures, page lifecycle and cross-tab selection remain isolated.
The [state-wait decision](2026-11-07-steps-session-state-waits.md) owns the reused
cadence, and the [workspace identity decision](../bug-fix/2026-11-05-stable-workspace-during-identity-checks.md)
owns the unchanged presentation and admission policy. The [Web validation guide](../../../../packages/daynight-web/README.md#development)
owns the commands and coverage gate.

## Alternatives

**Retain default polling for all predicates.** DOM mutations cannot notify a
request-counter change, and the extra sampling delay does not establish a
causal completion boundary.

**Shorten every DOM wait.** Expensive semantic predicates would be sampled more
often without binding them to cache, request or presentation completion. DOM
mutation observation remains useful for actual rendered state.

**Await a cache or recovery receipt before its React prerequisite commits.**
The awaited operation may be started by that pending commit, creating a cycle
inside asynchronous `act`. The authentication commit and sync-principal
inspection remain explicit prerequisites for their later observations.

**Add a generic request-observer framework or more controller readers.** A new
framework would own matching, deadlines and cleanup beyond this adjustment.
Additional readers can also retain resources that the lifecycle tests must
release. Existing operations and the existing waiter provide the observations
without changing ownership.

## Consequences

Non-DOM predicates can complete sooner while presentation remains independently
verified. The fixtures expose their actual I/O and React prerequisites instead
of relying on elapsed-time margins. More frequent state checks can consume more
CPU while an operation is slow; file, command and resource measurements remain
necessary. Query scopes preserve the intended owner, while global privacy,
absence and count assertions stay global. Local improvements do not establish
whole-Job savings or identify the cause of every instrumented timeout.
