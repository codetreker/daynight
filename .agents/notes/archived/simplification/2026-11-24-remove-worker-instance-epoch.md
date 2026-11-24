# Agent Note: Remove Worker Instance Epochs

Status: implemented

## Problem

Deleting the local Worker directory removes the registration record while the
configured Worker identity and service record survive. The service previously
required a predecessor epoch stored in that deleted record. A Worker with the
original configured identity could no longer start.

## Decision

Register the new management instance UUID directly. Use that UUID to associate
lifecycle operations and observations with their instance. Keep the existing
generation and sequence rules for execution scopes and reports.

An enabled Worker with reconnect eligibility can use the normal reconnect
activation after rebuilding its local state. Explicit disable and resume remain
independent lifecycle intents.

This supersedes the predecessor epoch requirement in the
[service authority decision](../architecture/2026-11-20-worker-lifecycle-authority.md)
and the [local lifecycle decision](../architecture/2026-11-21-worker-local-lifecycle.md).

## Alternatives

**Recover the predecessor epoch from the service.** This would retain a counter
that registration can proceed without and require another startup round trip to
recover it.

## Consequences

The configured Worker can register after losing its local lifecycle database.
The lifecycle API and its clients share the UUID-based contract. Older Worker
versions that use the epoch-based lifecycle contract need to be updated with
the service.
