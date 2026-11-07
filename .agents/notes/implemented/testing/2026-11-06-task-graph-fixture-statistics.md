# Agent Note: Task Graph Boundary Fixture Preparation

Status: implemented

## Problem

Task Graph boundary fixtures bulk-load large components into fresh private
PostgreSQL tables and query them immediately. Autovacuum may not yet have
collected statistics. Inaccurate cardinality estimates can give recursive
traversal a join order that repeatedly probes dependency indexes, making the
functional regression spend time on incidental preparation state.

The full backbone and convergent edges are necessary: the graph contract accepts
exactly 1000 nodes and 5000 dependency references while rejecting node and edge
overflow independently. Generating every candidate pair and sorting it before
keeping only a small prefix also makes fixture preparation unnecessarily costly.
The [chain-query decision](../architecture/2026-10-29-chain-scoped-task-graph.md)
owns selection and snapshot semantics.

## Decision

The service connected-graph fixtures and HTTP limit fixture analyze `tasks` and
`task_dependencies` after all dependency inserts and before graph queries.
[PostgreSQL ANALYZE](https://www.postgresql.org/docs/18/sql-analyze.html) collects
statistics for the loaded tables without forcing a join algorithm, changing the
statistics target or changing global database settings. An analysis error fails
fixture preparation.

The task service Graph and Sync seeds use triangular offsets to generate the same
ordered prefix of `(target, predecessor)` pairs directly. The connected seed
keeps the complete chain and generates its additional edges without duplicating
chain edges. The tests retain their node and edge counts, graph shape, exact limit
errors, empty refusals and proof that refused requests do not run the projection
query.

The [server validation guide](../../../../packages/daynight-server/README.md#task-graph-boundary-fixtures)
owns commands and test preparation. SQL-plan diagnostics explain the cost;
performance acceptance uses the ordinary configuration without auto_explain.
Representative wrong-limit mutations must still fail the original and optimized
boundary assertions, with the original graph shape preserved.

## Alternatives

**Reduce the graph or replace its backbone with a star.** A smaller or shallower
component loses exact-limit or deep-traversal coverage. The node-overflow chain
and shallow edge-overflow component protect separate refusal paths.

**Keep the Cartesian candidate generation.** Set-based inserts preserve the
shape, but generate and sort many more candidate pairs than the requested edge
count requires.

**Only batch fixture inserts further.** The fixture already uses set-based
inserts, which alone do not correct recursive-query cardinality estimates.
Direct edge generation instead reduces the work within an insert.

**Rewrite production traversal or cache its result.** That changes query and
snapshot behavior beyond fixture preparation. Native traversal remains the
mechanism verified by this regression.

## Consequences

Statistics collection adds a native preparation operation while allowing queries
to plan against the loaded component. All rows, dependency references, recursive
traversal and response assertions remain real. Collection occurs after the
complete load; moving it before extra links describes a different distribution.

Direct generation avoids the discarded candidate pairs and preserves the
previously selected edge set. Exact counts still traverse the component. This
does not establish a constant production query cost or force a production plan.
Database version, statistics and resource contention remain relevant to timing.
Race-enabled local and main measurements are separate from PR CI's existing
race-disabled policy; comparisons must use matching instrumentation and retain
unrounded coverage gates.
