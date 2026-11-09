# Agent Note: Business HTTP Request Metrics

Status: implemented

## Problem

Operators need request volume and latency without creating a series per resource
or conflating long-lived streams with ordinary HTTP requests. An interrupted
handler can exit without a response, while shutdown must still account for its
in-flight work.

## Decision

The business request logging seam observes each handler with the same response
recorder and a deferred finalizer. It registers bounded request counters, a
classic duration histogram and an in-flight gauge in the App registry before
listeners bind. Route templates and fixed method, mode and outcome values bound
cardinality. SSE is identified at response commitment and successful Hijack
identifies WebSocket; their duration is the handler lifetime. The
[metrics design](../../../../docs/design/server-metrics.md) owns the observation
and lifecycle details, and the server README owns the public metric contract.

## Alternatives

**Measure in each business module.** Separate instrumentation would duplicate
transport observations and miss common admission, rejection and panic paths.

**Label with raw paths or status and outcome on histogram buckets.** Resource
identifiers would create unbounded series, while multiplying every bucket by
status and outcome adds cost without being necessary for ordinary latency.

**Treat all requests to streaming routes alike.** The same MCP route can return
ordinary JSON or SSE, so route alone cannot distinguish request latency from a
long-lived stream.

## Consequences

Scrapes are separate from business request observations. Status and outcome
report the server's observation, not proof of complete client receipt. Hijack
classification relies on the server's current use of Hijack for WebSocket;
new protocols using it require reconsideration. No WebSocket frames, body or
MCP tool results are counted.
