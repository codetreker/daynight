# Agent Note: Task Graph Boundary Fixture Preparation

Status: implemented

## Problem

The former Task Graph boundary fixtures bulk-loaded large components into fresh
private PostgreSQL tables and queried them immediately. Autovacuum might not yet
have collected statistics. Inaccurate cardinality estimates could give recursive
traversal a join order that repeatedly probed dependency indexes, making a
functional regression spend time on incidental preparation state.

At the original decision, the graph contract accepted exactly 1000 nodes and
5000 dependency references while rejecting node and edge overflow independently.
The full backbone and convergent edges protected those separate boundaries;
reducing counts or depth would have weakened that proof. Generating every
candidate pair and sorting it before keeping a small prefix also made
preparation unnecessarily costly. The
[chain-query decision](../../archived/architecture/2026-10-29-chain-scoped-task-graph.md)
records the original selection and snapshot rationale.

## Decision

The [canonical batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md)
removes graph-size admission and its count-only capacity matrices. Current Store
tests use real ordinary graphs to verify complete selection, external dependency
arrays, snapshots and cancellation. CLI and Web consumers accept complete graphs
or sync responses beyond the former 1000-node and 5000-edge thresholds.

The original connected-graph and HTTP limit fixtures analyzed `tasks` and
`task_dependencies` after all dependency inserts and before queries.
[PostgreSQL ANALYZE](https://www.postgresql.org/docs/18/sql-analyze.html)
collected statistics without forcing a join algorithm, changing the statistics
target or changing global settings; an analysis error failed preparation.

Graph and Sync seeds used triangular offsets to generate the same ordered prefix
of `(target, predecessor)` pairs directly. The connected seed kept its complete
chain and generated additional edges without duplicating chain edges. Native
assertions retained exact counts, shape, projection contents and snapshots;
service mocks then required an overflowing count to prevent projection. These
were meaningful proofs while read capacities were part of the contract.

The fixtures originally lived with service Graph and Sync regressions. The
[Task service ownership decision](2026-11-08-task-service-test-ownership.md)
moved their physical query and traversal proofs into Store before the later
capacity removal. The [server validation guide](../../../../packages/daynight-server/README.md#task-graph-query-validation)
owns current commands and query verification. Historical SQL-plan diagnostics
explain fixture costs, without establishing a production plan or fixed runtime.

## Alternatives

**Reduce the graph or replace its backbone with a star while retaining limits.**
A smaller or shallower component would have lost exact-limit or deep-traversal
coverage. The node-overflow chain and shallow edge-overflow component protected
separate refusal paths under the original contract.

**Keep Cartesian candidate generation.** Set-based inserts preserved the shape
but generated and sorted many more candidate pairs than the requested edge
count required.

**Only batch fixture inserts further.** The fixture already used set-based
inserts, which alone did not correct recursive-query cardinality estimates.
Direct edge generation reduced work within an insert.

**Rewrite production traversal or cache its result for fixture performance.**
That would have changed query and snapshot behavior beyond the preparation
problem. Native traversal remained the verified mechanism.

## Consequences

The original preparation collected statistics after complete loading and avoided
discarded candidate pairs while preserving the selected edge set. Moving analysis
before extra links would have described a different distribution. Neither
fixture optimization established constant production query cost or forced a
production plan; database version, statistics and resource contention still
mattered to timing.

The capacity-only matrices no longer define current read acceptance. Ordinary
Store witnesses preserve actual graph access and snapshots, while caller tests
verify that the old size gates cannot reject complete successful responses.
Race-enabled local and main validation remains separate from PR CI's existing
race-disabled policy, with matching instrumentation and unrounded coverage gates.
