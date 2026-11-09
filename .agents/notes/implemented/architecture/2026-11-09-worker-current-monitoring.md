# Agent Note: Worker Current Monitoring Storage

Status: implemented

## Problem

Operators need current Worker progress, capacity and bounded failure information
without turning execution diagnostics into a retained log. Worker observations
can arrive late, overlap across runs or contain associations that the account
can no longer access. Monitoring storage failures must not stop task execution or
make the existing Worker reporting and readiness depend on another service.

## Decision

The server accepts a closed, bounded current observation and stores one expiring
Redis String per account and Worker. A header supports bounded summary reads;
a single `SET EX` replaces the complete frame and its TTL after ordered CAS
checks. Redis time supplies receipts and observation anchors. A separate
monitoring connection has a fixed operation deadline and does not participate
in PostgreSQL transactions or readiness.

Current PostgreSQL access determines association visibility on every detail
read. Total capacity is independent of visible details, and old cleanup
associations do not prove an active claim. Diagnostic text uses fixed classified
summaries so remote status does not carry arbitrary local errors. The
[contract](../../../../docs/spec/daynight-worker-monitoring.md) owns the exact
fields, bounds and errors; the [design](../../../../docs/design/daynight-worker-monitoring.md)
owns the server mechanisms. The existing [Worker boundary decision](2026-11-05-server-worker-boundaries.md)
continues to own the organization of Worker report and configuration operations. The [summary permission decision](2026-11-09-monitoring-summary-permissions.md)
extends the header with private references for current list projection.

## Alternatives

**Redis Hash with separate expiry.** Hash fields make metadata comparison
convenient, but updating content and expiry requires separate writes. A failure
between them leaves a state whose retention no longer matches the observation.

**Extend the PostgreSQL Worker snapshot.** This would reuse an existing query
path but couples monitoring to the business snapshot and does not satisfy the
independent Redis storage requirement.

## Consequences

A complete frame and expiry are replaced in one write, while summaries avoid
loading full observations. Redis loss discards current monitoring state and
cannot preserve cross-machine run ordering after all metadata is lost. Monitoring
failure remains visible to its callers without blocking existing PostgreSQL
business operations. Fixed diagnostic summaries prevent arbitrary error text
from crossing the monitoring boundary at the cost of remote detail; local
diagnostics retain that detail. Worker-side capture and Web presentation have
independent implementation and acceptance responsibilities.
