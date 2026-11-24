# Agent Note: Go Module CI Throughput

Status: implemented

## Problem

The ordinary Go module check spent time compiling separate vet and coverage
graphs. On slower runners its two-package schedule also left a long tail after
the PostgreSQL Store root finished. Database fixtures perform real schema
creation, catalog work and transactions, which compete with test compilation
for the resources of a single hosted runner. The module check also prepared its
authentication fixture after its independent script contract tests completed.

## Decision

The Go module job executes its complete ordinary test package list in one
coverage invocation. The invocation applies all standard vet analyzers to its
compiled package and test variants. The independent lifecycle job owns both the
ordinary command vet pass and the tagged command vet and coverage. The complete
cross-package coverage universe, failure propagation and coverage gates still
apply to the module.

Pull requests use a four-package Go schedule in the same module job. Its
isolated PostgreSQL service uses a bounded memory-backed data directory. The
workflow checks the actual mounted filesystem before preparing the dedicated
Store root database. PostgreSQL sync, transaction and migration lock behavior
remain intact. Local and main package concurrency stay at two, with the
existing race policy for each entry. The ordinary command vet also uses four
package slots in PR CI; lifecycle coverage retains two.

In PR CI the module check overlaps the Node script contract tests with the
fixed UniAuth fixture preparation and its explicit `testauth` invocation. The
contract tests use isolated temporary fixtures; the authentication stage owns
the module Go cache until both stages finish. Both must succeed and the fixture
must be read back before the ordinary cache cleanup and coverage invocation.
Local and main validation retain the sequential preparation order.

## Alternatives

**Vet the full module in a second build graph.** This repeats dependency
preparation and compilation. Go can apply the full analyzer set to the same
source in the coverage graph, including packages without tests.

**Change the production migration lock to increase fixture throughput.** Old
and new binaries must interoperate when coordinating schema initialization.
Keeping the lock also preserves the real database contention exercised by
the tests.

**Keep preparation sequential.** This avoids overlapping resource use, but
leaves the independent contract tests and authentication preparation on the
same critical path.

## Consequences

The module job records phase timings and the usual raw Go test evidence.
Moving ordinary command vet to the independent lifecycle job retains the check
without putting its separate compile graph on the module job's critical path.
Memory-backed PostgreSQL consumes runner memory up to its configured limit.
The hosted check establishes elapsed time and exercises the complete suite
under the selected package concurrency.
Parallel preparation adds process and cancellation coordination. Its stage
timings expose resource contention, and its failure paths do not admit an
incomplete fixture into the covered Go suite.
