# Agent Note: Localhost monitoring Redis

Status: implemented

## Problem

The localhost deployment needs short-lived Worker monitoring storage without
making PostgreSQL business operations depend on a healthy monitoring service.
Unbounded or silently evicted state would make capacity failures hard to detect.

## Decision

The Compose stack runs a pinned Redis on its internal network, with an explicit
operator-configured memory budget and `noeviction`. RDB and AOF are disabled and
no persistent volume or host port is provided. Server connects through the
configured URL without a Redis health or restart dependency. The
[deployment guide](../../../../deployment/localhost/README.md) owns operation and
configuration; the [monitoring storage decision](2026-11-09-worker-current-monitoring.md)
owns the state and failure contracts.

## Alternatives

**Persist Redis state.** Persistence would retain transient observations across
restarts, adding backup and recovery responsibilities for data that is recaptured
from current Worker state.

**Evict keys under pressure.** Eviction would silently remove monitoring states;
rejecting writes makes exhausted capacity visible to monitoring callers.

## Consequences

Redis loss discards monitoring state, and recovery depends on subsequent Worker
collection. Operators must choose and monitor a suitable budget; the configured
limit is not a guarantee of capacity for arbitrary workloads. Monitoring errors
remain separate from PostgreSQL business readiness.
