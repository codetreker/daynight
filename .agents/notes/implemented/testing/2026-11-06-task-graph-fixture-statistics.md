# Agent Note: Planner Statistics for TaskGraph Boundary Fixtures

Status: implemented

## Problem

A TaskGraph boundary fixture bulk-loads a large connected component into fresh
private PostgreSQL tables and queries it immediately. Autovacuum may not have
collected statistics yet. Inaccurate cardinality estimates can give the recursive
traversal a join order that repeatedly probes dependency indexes, making the
functional regression spend time on incidental preparation state.

The fixture's full backbone and convergent edges are necessary: the graph
contract accepts exactly 1000 nodes and 5000 dependency references, while rejecting
node and edge overflow independently. Reducing counts or depth would remove that
boundary proof. The [chain-query decision](../architecture/2026-10-29-chain-scoped-task-graph.md)
owns selection and snapshot semantics.

## Decision

`seedConnectedGraph` analyzes `tasks` and `task_dependencies` after both dependency
inserts complete. It preserves the complete backbone and additional forward
links, then returns the target for the existing real count and projection queries.
The three boundary cases retain their data, exact counts, limit errors, empty
refusals and proof that refused requests do not run the projection query.

[PostgreSQL ANALYZE](https://www.postgresql.org/docs/18/sql-analyze.html) collects
statistics for the listed tables so the planner can use their contents. The
fixture uses ordinary collection with no forced join algorithm, changed
statistics target or global database setting. Its private schema remains the
resource owner; an analysis error fails fixture preparation. Production SQL,
migrations, locks, deadlines and instrumentation policies remain in place.

The [server validation guide](../../../../packages/daynight-server/README.md#task-graph-boundary-fixtures)
owns commands and test preparation. SQL-plan diagnostics explain the cost;
performance acceptance uses the ordinary configuration without auto_explain.
Representative wrong-limit mutations must still fail the original and optimized
boundary assertions, with the original graph shape preserved.

## Alternatives

**Reduce the graph or replace its backbone with a star.** A smaller or shallower
component loses exact-limit or deep-traversal coverage. The node-overflow chain
and the shallow edge-overflow component also protect separate refusal paths.

**Batch fixture inserts further.** Tasks and dependencies are already populated
with set-based SQL. This does not address the subsequent recursive query's
cardinality estimates.

**Rewrite production traversal or cache its result.** That changes query and
snapshot behavior beyond controlling incidental fixture statistics. Native
traversal remains the mechanism verified by this regression.

## Consequences

Statistics collection adds a small native preparation operation while allowing
queries to plan against the actual loaded component. All rows, dependency
references, recursive traversal and response assertions remain real. Statistics
collection occurs after the complete load; moving it before the extra links
would describe a different fixture distribution.

Exact counts still traverse the component. This does not establish a constant
production query cost or force a production execution plan. Database version,
statistics and resource contention remain relevant to timing. Race-enabled local
and main measurements are separate from PR CI's existing race-disabled policy;
comparisons must use matching instrumentation and retain unrounded coverage gates.
