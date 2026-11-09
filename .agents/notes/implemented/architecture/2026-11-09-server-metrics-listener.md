# Agent Note: Independent Runtime Metrics Listener

Status: implemented

## Problem

Operators need process and Go runtime observations without exposing them through
business routes or tying their lifetime to a global registry. A scrape may still
be collecting while the server is shutting down, so listener shutdown alone does
not prove that App-owned resources are no longer in use.

## Decision

An explicitly configured metrics address enables an App-owned Prometheus registry
and a separate HTTP listener. An empty address disables both. Official Go and
process collectors register with that instance, with registration and collection
errors visible. Runtime binds both endpoints before starting the App and owns
both Serve results and their coordinated shutdown. Metrics admission tracks active
scrapes until collection actually ends; App resources remain owned until all
relevant work drains. The [metrics design](../../../../docs/design/server-metrics.md)
owns the transport, lifecycle and deployment details.

The localhost and dev-ci gateways use separate TCP streams for business and
metrics in the shared network namespace. Each host mapping binds loopback. This
extends the [original localhost topology](../../archived/architecture/2026-10-20-localhost-compose.md)
without changing its business forwarding or database publication rules.

## Alternatives

**Use the business listener.** A shared route would couple scrape access to the
business port and its admission, preventing independent network restrictions and
separate scrape draining.

**Use the global default registry.** Process-global registration couples App
instances and can create duplicate registrations or cross-instance observations.

**Use OpenTelemetry or encode metrics manually.** An exporter adds a lifecycle
and abstraction not needed for this pull endpoint; manual encoding would require
maintaining exposition, negotiation and platform-specific collectors.

**Detach or coalesce collection behind a handler timeout.** Returning a response
before collection exits would break the ownership proof needed to close App
resources safely. Socket timeouts do not substitute for actual drain.

## Consequences

The endpoint uses the official Prometheus client and collectors, with a bounded
number of concurrent scrapes. Platform-specific collector availability remains
visible, and Linux process collection requires readable `/proc`. The endpoint has
no application authentication; deployments must restrict its network access.
Shutdown can retain resources after a timeout until a blocked collector exits.
No collection service, history, dashboard or alerting is provided by this listener.
