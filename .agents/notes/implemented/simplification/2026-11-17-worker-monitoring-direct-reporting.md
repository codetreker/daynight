# Agent Note: Direct Worker Monitoring Reports

Status: implemented

## Problem

Monitoring describes a replaceable current observation, yet a producer that
must read and reconcile the existing value can be blocked by an old observation
or a reader that cannot decode it. Worker processes on independent machines do
not upgrade with the Server, and existing Workers and Web readers must continue
to work when the Server is updated first.

## Decision

The Server accepts direct POST observations without reading, comparing or
reconciling the previous snapshot. Each successful save atomically replaces the
single current frame and renews its expiry. The last successful write wins even
when it carries an earlier capture. Existing GET, PUT, query and CAS semantics
remain available to supported legacy Workers. A generated sample ID supplies the
run ID and sequence required by existing readers; it is not a process identity
or an ordering mechanism. The [contract](../../../../docs/spec/daynight-worker-monitoring.md)
and [design](../../../../docs/design/daynight-worker-monitoring.md) own the
protocol, budgets and deployment constraints.

This changes the universal ordering premise of the [storage decision](../architecture/2026-11-09-worker-current-monitoring.md)
while retaining its isolation, single-frame storage and legacy CAS guarantees.
The [capture decision](../architecture/2026-11-09-worker-monitoring-capture.md)
records the producer lifecycle. New CLI Workers capture fresh observations for
direct POST without reading or reconciling old snapshots; existing running
Workers retain their original protocol until upgraded.

## Alternatives

**Distinguish protocols by PUT body shape.** Mixing unconditional and CAS writes
under one method obscures their error and compatibility boundaries.

**Keep separate keys for old and direct reports.** Readers would need a current
value selection rule or dual writes, adding expiry and partial-failure concerns.

**Retain CAS with a lightweight metadata read.** This still makes an existing
value a prerequisite to reporting current state and retains reconciliation.

**Require all clients to adopt a new format together.** Independent running
Workers cannot all be upgraded when the Server is deployed.

## Consequences

Delayed or repeated direct reports can temporarily replace newer observations;
monitoring remains independent of execution and ownership decisions. Server
retains both write mechanisms and a compatibility envelope until a separate
support and migration decision permits retirement. Direct producers require all
traffic-serving Servers to support the endpoint and private body allowance;
rollback to an older Server requires draining direct writes and natural expiry
or proof that incompatible frames were replaced. The storage and business data
are not deleted to perform this transition.
