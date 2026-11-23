# Agent Note: Step Read Coordination Tests

Status: implemented

## Problem

Step read service tests used controlled DAOs but executed Project authorization
to obtain fixed access. This coupled the service's snapshot and result handling
proof to another module's business decisions. The earlier [Task service test
ownership decision](2026-11-08-task-service-test-ownership.md) removed database
setup while retaining that lower business path.

## Decision

The [application retirement](../simplification/2026-11-23-retire-task-steps-application.md) removes the Step
service and its dedicated coordination tests. This record preserves the original
test ownership and alternatives; PostgreSQL retains its physical proofs.

The original `NewTaskSteps` bound Project read authorization per instance. The four public
read methods executed the service's actual snapshot callback, parent admission,
DAO queries, paging, projection and JSON encoding with controlled authorization
and scope capabilities. Tests checked capability identity, context, canonical IDs,
order, absence of later calls on refusal, and the complete returned resources.
They controlled callback and snapshot completion independently, including cleanup
failure and suppression of results after completion failed.

The Step service owned these queries and pure output mechanisms; they were not
forwarded through Core merely to make them mockable. Ordinary Step reads retained
complete content without the separate Task Session Work overview response budget.

## Alternatives

**Keep the Project DAO as the authorization boundary.** This would continue to
execute Project business rules while testing Step service coordination.

**Mock the entire read helper or move its queries into Core.** Either would hide
the service's actual parent gate, DAO arguments, pagination and output handling,
or add a forwarding layer without an independent responsibility.

## Consequences

The service tests isolated the directly invoked business operation while retaining
the existing read inputs and failure paths. A controlled scope proves callback
coordination and error propagation, not a physical PostgreSQL snapshot or
durability. The Project operation and store retain their own rule and physical
proofs. Source-bound comparisons must measure the whole affected package under
matching conditions; the boundary alone does not establish a CI speedup.
