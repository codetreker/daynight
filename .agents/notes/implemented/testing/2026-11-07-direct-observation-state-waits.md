# Agent Note: Direct-observation state waits

Status: implemented

## Problem

Direct-observation tests exercise asynchronous task and Step state without
rendering a DOM. Testing Library's default 50ms interval adds idle time between
successive reads, writes and reconciliation checks. Parent readiness alone also
does not establish that a reopened Steps collection and any resulting automatic
parent refresh have finished. Fault responses armed at that intermediate state
can affect reopening reads rather than the retired write's parent check.

## Decision

The direct-observation suite uses the existing
`packages/daynight-web/tests/helpers/waitForState.ts` for non-DOM assertions. The
helper delegates to React Testing Library with a 5ms default interval and retains
its generic signature, immediate checks, asynchronous callbacks, explicit options,
timeouts, diagnostic errors and cleanup.

The retired Step parent-check fixtures reopen their existing session and jointly
wait for the expected parent and Steps versions. The parent must be ready and not
refreshing; Steps must be ready, not refreshing and not stale. Only then are the
parent-check faults armed. The original pending write, refusal attribution,
read-only retry, history replacement and request-count assertions remain intact.
No temporary reader subscription is introduced: the real session and storage
owners keep their existing lifecycle and event-loop work.

The [earlier state-polling decision](../../archived/testing/2026-11-04-web-controller-state-polling.md)
records the original adoption for platform, pause, status and assignment suites.
This suite extends that cadence with explicit reopening readiness; it does not
change product polling or DOM-test defaults. The [Web validation guide](../../../../packages/daynight-web/README.md#development)
owns the test commands and coverage gate.

## Alternatives

**Retain the 50ms interval.** Its extra delay can let background reopening reads
settle, but it neither identifies their completion nor belongs to the behavior
these state tests prove.

**Change the import without defining the reopening phase.** Faster observation
can satisfy a parent-ready check before the Step read or its automatic parent
refresh settles. A fault shared by subsequent parent requests would then test a
different request than intended.

**Observe through additional session subscriptions.** Detail and Step
subscriptions own read lifetimes. Adding a temporary observer can keep a closed
read alive, and removing the final reader can release its resource. Waiting on
existing state retains the tests' actual ownership while reusing Testing
Library's timeout and error handling.

## Consequences

State assertions can observe completed work sooner without reducing their
failure budgets or replacing real IndexedDB transactions with clock advancement.
Pending assertions may be checked more often, so callback cost and resource use
remain part of validation. Parent-check faults have an explicit starting phase,
while tests that deliberately overlap reads retain their own held responses and
ordering. File and case improvements do not establish a whole-Job improvement
under parallel execution.
