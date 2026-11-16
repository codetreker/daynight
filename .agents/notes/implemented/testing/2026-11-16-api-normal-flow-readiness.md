# Agent Note: Observe Normal API Flow Readiness

Status: implemented

## Problem

A normal assembled API journey can accidentally overlap an asynchronous first-use
metadata write with a later authorization transaction, or keep live sockets past
the lifetime of the claim they authenticate. Those schedules turn ordinary
success and cleanup assertions into uncontrolled contention or revocation cases.
The integration suite must retain real services and errors while making its
normal preconditions explicit.

## Decision

The readonly application journey first performs a normal identity GET, then
observes that the same OAuth grant's usage timestamp was committed. Preparation
and the complete readonly exchange share a five-second context, explicitly
required to remain shorter than the sampler's cooldown. Later usage events stay
outside that successful exchange's grant-lock interval. The real OAuth client,
Worker socket, dispatch transaction and all response assertions remain in use.

The Session journey owns its live Controller and browser sockets in a synchronous
subtest. Their existing checked cleanup completes before the parent starts the
reopen and replacement-claim phase. A failed close still fails the test and
prevents that successor phase from running.

The [test rules](../../../../docs/writing_tests.md) retain module, Store and
runtime ownership of contention, revocation and failure matrices. The
[API guide](../../../../packages/daynight-server/README.md#go-api-integration)
owns the production runner and its source receipts. No production timer, lock,
error propagation, numerical gate or retry budget is relaxed.

## Alternatives

**Allow lock failures or abnormal closes in normal cleanup.** That would remove
the suite's ability to detect an unexpected error in a successful journey.

**Keep retrying the same schedule.** A passing attempt would not establish
readiness or correct resource ownership; identical contention can recur.

**Change the production usage writer or revoke behavior.** The writer's NOWAIT
failure semantics and the Session's claim checks have separate decision owners.
Changing them requires their own compatibility and concurrency analysis. The
SSO protocol does not depend on either redesign, and these fixtures retain the
existing observable errors so later work can be validated independently.

## Consequences

Readonly preparation adds one real identity request and a bounded persistence
observation. A changed cooldown that cannot contain the exchange fails clearly.
The observation also covers an event recorded while a committed sample is still
completing in the sampler; no arbitrary sleep establishes readiness.

The production usage writer can still conflict with a concurrent grant recheck,
and stale-claim sockets still fail as before. Their repair cost stays with their
existing modules; the fixtures add no synchronization API or shared runtime
state that a later repair would need to remove. Severe scheduling delays remain
visible deadline failures. Session timeline and identity assertions retain the
same connections and data before those connections are closed.
