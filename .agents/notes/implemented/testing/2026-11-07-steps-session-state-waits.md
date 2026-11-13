# Agent Note: Steps session state waits

Status: implemented

## Problem

Most Steps session tests observe asynchronous controller and cache state rather
than DOM changes. Testing Library's default 50ms sampling interval delays those
observations even when the operation has already completed. The same suite also
contains real panel and hook tests whose React reader lifecycle can temporarily
release a collection during history replacement. Observing the expected Steps
version and the expected parent version at separate moments does not prove that
the replacement collection and retained draft are ready together.

## Decision

Non-DOM assertions in the Steps session suite use the existing
`packages/daynight-web/tests/helpers/waitForState.ts`. It delegates to React
Testing Library with a 5ms default interval while preserving immediate checks,
asynchronous callbacks, explicit options, failure deadlines, errors and cleanup.
DOM predicates retain React Testing Library's default waiter through a distinct
`waitForDom` import.

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

**Shorten every wait without defining UI convergence.** A Step-version assertion
can succeed before inactive-reader cleanup releases the collection. A separate
fresh-parent assertion can then succeed while the restored panel's new Step read
is pending. Neither establishes the rendered collection and draft at that point.

**Add a temporary state observer.** Detail and Step subscriptions own read
lifetimes. An extra observer can retain a hidden collection or prevent the final
reader from releasing it, changing the lifecycle the tests must exercise.

## Consequences

Controller state can be observed sooner while real panel assertions wait for
committed UI and matching resources. Assertions may execute more often during a
slow operation, so callback and resource costs remain part of validation. The
original fixtures, identity checks, history replacement, release orderings,
late-response rejection, deadlines and no-replay proofs remain necessary. Local
case and file savings do not establish a whole-Job improvement under parallel
execution.
