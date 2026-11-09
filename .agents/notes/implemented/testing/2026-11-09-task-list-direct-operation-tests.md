# Agent Note: Task List Direct Operation Tests

Status: implemented

## Problem

Task List assignment tests execute authorization and business reads through DAO
mocks. Their query and cursor assertions therefore run inside service
coordination, and the same matrix repeats the service snapshot callback for
lower-owned selection behavior. Database independence alone does not establish
the service's directly invoked operation boundary.

The earlier [Task service ownership decision](2026-11-08-task-service-test-ownership.md)
removed PostgreSQL preparation while retaining existing business paths and
physical witnesses in their storage owners. This decision partially supersedes
its DAO boundary for List coordination and the three assignment functions.

## Decision

`NewTasks` binds the actual project read authorization and Task List read
operations per instance. The List method supplies capabilities from its actual
snapshot callback. Its coordination tests control those two operations and
verify context, complete principal, canonical Project identity, capability
identity, call order, staged faults, error chains and snapshot-completion
precedence. Configured results and completion errors remain independent facts.

`SelectList` remains real input and cursor planning; `ProjectList` remains real
output projection and cursor encoding. A controlled year-10000 timestamp makes
the actual cursor encoder fail only after successful snapshot completion. A
snapshot failure must suppress both a supplied page and a staged domain fault.
No database snapshot or persistence claim follows from a successful mock scope.

Core tests execute the original three assignment functions through actual
selection, read and projection. They retain all 360 filter combinations, complete
Task data, opaque property JSON, non-nil empty slices, nanosecond pagination,
Worker inventory and historical assignment facts. Cursor scope remains version
2, including equivalence of `me` and the canonical actor UUID and refusal of
version 1 or changed assignment scope. A narrow reader checks independently
written complete queries and returns explicit page stages; it does not filter
rows or simulate storage.

The old shared fixture replaced its expected Limit with the actual value and
checked only that it was positive. Exact Limit checks in the receiving Core
fixture strengthen that assertion. The original matrix did not establish exact
authorization-call counts; the service operation tests supply that separate
coordination proof.

## Alternatives

**Keep DAO mocks as the List service boundary.** This executes lower
business operations while checking service assembly and repeats that assembly
for the lower selection matrix.

**Mock selection and projection as well.** These are pure input/query planning
and encoding mechanisms. Controlling them would remove the actual cursor scope,
format and encoding-failure paths that the tests need to observe.

## Consequences

The selected service coordination and receiving Core tests execute without
database or UniAuth fixtures. Default constructor bindings retain production
behavior. Platform and agent-permission tests continue using their shared
DAO-based List fixture; other Task read operations retain their existing owners.

Source-bound comparisons include the receiving Core package and full validation.
The original case cost and any observed package differences remain separate
measurements; moving the matrix does not by itself establish faster CI.
