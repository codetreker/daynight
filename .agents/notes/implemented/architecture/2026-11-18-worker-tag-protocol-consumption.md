# Agent Note: Worker Tag Protocol Consumption

Status: implemented

## Problem

A Worker needs to bind candidate pagination and claim admission to its applied
filter while configuration can change during an acquisition cycle. Existing
claims and uncertain writes still need their original reconciliation path.

## Decision

The coordinator captures an optional filter digest in its immutable configuration
view. An absent value preserves the old service protocol; null suspends new
claims; a digest adds the Worker identity to every candidate page and the digest
to the claim. A changed view fences unsent claims. Deterministic cursor and claim
conflicts with filter context signal a configuration recheck without asserting
its cause. The [Worker design](../../../../docs/design/daynight-worker.md) owns
the consumption and recovery behavior.

## Alternatives

**Use the latest digest only at claim time.** A candidate selected in an older
cycle would be interpreted under a different applied view, weakening the local
admission boundary.

**Treat a wake-up as a configuration read.** A scheduler tick does not establish
that the authoritative target was reread; the callback leaves that responsibility
to the configuration owner.

## Consequences

Already dispatched claims rely on server admission and ordinary inventory
reconciliation. The current runtime omits the optional value until its applied
configuration producer is connected; it does not advertise filter support.
