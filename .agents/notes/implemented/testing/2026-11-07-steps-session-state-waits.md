# Agent Note: Steps session state waits

Status: implemented

## Problem

Most Steps session tests observe asynchronous controller and cache state rather
than DOM changes. Testing Library's default 50ms sampling interval delays those
observations even when the operation has already completed. The same suite also
contains real panel and hook tests whose React reader lifecycle can temporarily
release a collection during history replacement. Observing the expected Steps
version and the expected parent version at separate moments does not prove that
the replacement collection and retained draft are ready together. A fresh Steps
resource can also finish loading before the parent detail has completed admission;
its version alone cannot establish that Step writes are enabled.

## Decision

Non-DOM assertions in the Steps session suite use the existing
`packages/daynight-web/tests/helpers/waitForState.ts`. It delegates to React
Testing Library with a 5ms default interval while preserving immediate checks,
asynchronous callbacks, explicit options, failure deadlines, errors and cleanup.
DOM predicates retain React Testing Library's default waiter through a distinct
`waitForDom` import.

The ordinary Task-write fixture holds the matching parent-detail admission result
after its real IndexedDB transaction completes. While the independent Steps
resource is ready, fresh and no longer refreshing, the public parent snapshot
still requires a fresh read and Step status writes remain disabled. A status
attempt at that boundary sends no PUT. The held result is released in `finally`;
the final wait jointly requires the expected parent detail without a fresh-read
requirement, the exact ready, nonstale, nonrefreshing Steps resource without an
error, and enabled Step writes. The single Task PATCH and absence of Step PUTs
remain explicit assertions.

The real panel fixtures require both writable Step state and a rendered row
before interaction. History-replacement fixtures flush pending React work and
jointly require the expected fresh parent, a ready, nonstale, nonrefreshing Steps
resource with exact content, the visible row and the unchanged dirty title.
The held receipt's release remains before or after that readback according to
the scenario. Final reconciliation, exact resource, draft enablement and single
DELETE assertions remain intact.

The waits introduce no reader subscriptions and replace no IndexedDB or
transport boundaries. An inactive panel still releases its actual reader;
restored parent state reactivates the panel and its real Step read. The
[direct-observation decision](2026-11-07-direct-observation-state-waits.md)
owns the corresponding reopening phase for direct reads, while the
[original polling decision](../../archived/testing/2026-11-04-web-controller-state-polling.md)
records the earlier controller-only adoption. The [Web validation guide](../../../../packages/daynight-web/README.md#development)
owns commands and the coverage gate.

## Alternatives

**Keep 50ms polling for every assertion.** Extra sampling delay can conceal an
intermediate reader transition without identifying its completion. It also
accumulates across controller-only state checks.

**Shorten every wait without defining convergence.** A Step-version assertion
can succeed before parent-detail admission completes or before inactive-reader
cleanup releases the collection. A separate fresh-parent assertion can then
succeed while the restored panel's new Step read is pending. These observations
do not establish write admission or the rendered collection and draft together.

**Add a temporary state observer.** Detail and Step subscriptions own read
lifetimes. An extra observer can retain a hidden collection or prevent the final
reader from releasing it, changing the lifecycle the tests must exercise.

## Consequences

Controller state can be observed sooner while mutation and real panel assertions
wait for all required parent and resource state. The ordinary-write fixture
executes the disabled admission boundary deterministically without delaying the
underlying database transaction. Assertions may execute more often during a
slow operation, so callback and resource costs remain part of validation. The
original fixtures, identity checks, history replacement, release orderings,
late-response rejection, deadlines and no-replay proofs remain necessary. Local
case and file savings do not establish a whole-Job improvement under parallel
execution.
