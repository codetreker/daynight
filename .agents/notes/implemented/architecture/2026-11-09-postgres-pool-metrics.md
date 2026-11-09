# Agent Note: PostgreSQL Pool Metrics

Status: implemented

## Problem

Operators need to observe application connection pressure and acquisition waits
without mistaking them for SQL execution latency or database server resource use.
Collection must reflect the pool actually used by each App and remain safe during
shutdown.

## Decision

The PostgreSQL store supplies a collector for its pool through the concrete
persistence assembly seam. Each enabled App registers that collector in its own
registry; registration failures fail assembly. A collection maps one local pgx
statistics snapshot to fixed gauges and cumulative counters, with durations in
seconds and only three fixed connection-state labels. It issues no SQL and does
not own the pool. The [metrics design](../../../../docs/design/server-metrics.md)
describes assembly and the listener's drain ownership.

## Alternatives

**Query database statistics.** Server-wide statistics would describe a different
resource and introduce database I/O and failure modes into each scrape.

**Sample in the background or derive deltas.** Local cumulative pgx statistics
already provide the required values; sampling adds scheduling, cleanup and
reset semantics without improving the snapshot contract.

## Consequences

Pool pressure and successful acquisition waits can be observed independently per
App without SQL or high-cardinality labels. The counters follow pgx's successful
acquisition and empty-wait definitions and reset with the process. They do not
measure SQL latency or all database server resources. The listener's existing
scrape drain keeps the pool alive until collection ends.
