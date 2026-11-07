# Agent Note: Settings and management test observations

Status: implemented

## Problem

Project-settings route-retention and management tests repeatedly wait for request
counts, mocked callbacks and abort signals that do not notify a DOM observer.
The default 50ms sampling interval adds idle time without identifying response
admission. Semantic button and field discovery also repeats work across the full
authenticated page or a management page containing an unrelated panel and dialog.
A helper that discovers an enabled button and then discovers it again spends
additional work within the same stable interaction phase.

## Decision

Pure request, mock-callback and abort predicates use the existing
`packages/daynight-web/tests/helpers/waitForState.ts`. DOM predicates and the
mixed request-or-visible-retry predicate retain React Testing Library's default
waiter. The original immediate check, deadline, errors and explicit options
remain in force. Dispatch observations identify that a request started; held
responses, real IndexedDB admission, access recovery and rendered receipts
continue to establish their separate lifecycle boundaries.

Settings Save and Cancel controls are queried by role and accessible name within
the current settings panel. Transfer Cancel belongs to its current dialog.
Token creation labels are queried within their current form, and member role
controls within the current roster. Readiness helpers return their already
enabled semantic button and click that same node. Query owners are reacquired
at each assertion or interaction so a later route or data revision is not
mistaken for a retained node. Assertions specifically proving retained nodes
keep their original identities. Global secret, privacy, absence, focus and
duplicate-control checks retain their original scope.

The settings tests retain the full authenticated application, real routing,
cache ownership, dispatched writes, save/transfer exclusion, Cancel/Restore
choices and read-only reconciliation. Management tests retain Alice, exact
int64 grant versions, roster and invitation retention, secret selection and
clipboard behavior, locale changes, real MembersPanel access and cache
admission. Fixture data, cache wrappers, production timing and test deadlines
are unchanged. The [state-wait decision](2026-11-07-steps-session-state-waits.md)
owns the reused cadence, and the [Web validation guide](../../../../packages/daynight-web/README.md#development)
owns the commands and coverage gate.

## Alternatives

**Keep the default interval for every observation.** Request counters and abort
signals cannot wake the DOM observer; extra idle sampling does not strengthen
the proof of dispatch or cancellation.

**Shorten all DOM waits.** Frequent full-page semantic queries would increase
CPU work and retain the wrong cost mechanism for actual rendered state. Mixed
predicates still require the DOM observer and its default interval.

**Replace the authenticated page or MembersPanel with a smaller mock harness.**
The real route, access, cache and admission lifetimes are the mechanisms being
verified. Replacing them would remove the required rejection and retention proof.

**Remove cache wrappers or reduce invitation-only rosters.** Account and feedback
consumers do not use the cache, but the scope opens storage lazily. A wrapper's
presence does not establish a database operation or a material saving. No
measured fixture reduction is adopted, and the existing Alice and boundary data
remain intact.

## Consequences

Non-DOM observations can complete sooner while response and presentation
assertions remain independent. Scoped semantic queries avoid unrelated DOM
work while preserving the tested accessible names and owner. More frequent
state sampling can cost more CPU when real I/O is slow, so file, command and
resource measurements remain necessary. Local improvements do not establish
whole-Job savings. Cache construction and real admission remain part of the
existing fixture cost.
