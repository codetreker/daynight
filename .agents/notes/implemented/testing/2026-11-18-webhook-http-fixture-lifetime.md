# Agent Note: Webhook HTTP Fixture Lifetime

Status: implemented

## Problem

The Webhook HTTP configuration, committed-write and subscription tests
repeatedly create the same PostgreSQL schema, pool and base listener. Most
readback assertions scope their queries to distinct owners, endpoints and
operation IDs. The invalid subscription array case is an exception because
its rejected creates must leave all four configuration tables empty.

## Decision

The owner CRUD and byte-boundary cases run as sequential children in the
configuration lifecycle test. The response-loss, post-commit authorization and
subscription groups also each open one fixture in their parent. Each parent
owns its schema, pool and base listener. Each scenario has a thirty-second
context and fresh actor, credential, owner and operation data.
[Webhook DAO fixture decision](2026-11-10-webhook-dao-group-fixtures.md)

The subscription group starts with invalid arrays, so the global SQL count
verifies the absence of endpoint, subscription, binding and operation writes.
Its valid control and subsequent invalid patches retain endpoint-specific
readback. The eligibility and 51-subscription scenarios then use new users,
Teams, Projects and operations. Their assertions scope reads to those owners
and endpoints, so the group needs no data reset between scenarios.

Response-loss injection retains a case-local writer, production router and
logger. The authorization-change cases retain a case-local post-commit gate,
logger and real HTTP listener. Child cleanup releases the gate, closes that
listener and joins its client before the next scenario. Production
authentication, parsing, transaction execution, receipt recovery and
independent SQL verification remain in the tests.

## Alternatives

**Create a fresh schema and base listener for every case.** This makes isolation
independent of query scopes but repeats migrations and resource setup. Running
the subscription zero-effect case first preserves its global observation.
The remaining assertions already use scenario-owned data.

**Share a fixture across the package.** Schema-wide failure injection and
other cases have different lifetime requirements. Restricting reuse to focused
parents keeps those mechanisms independent and lets each parent own teardown.

## Consequences

The original configuration and committed-write groups share three lifecycles
among six cases. The three subscription scenarios share one additional
lifecycle. Their setup still requires an isolated PostgreSQL database. Cases
involving schema mutations, history, physical COMMIT acknowledgement loss or
concurrent transaction locks retain their own infrastructure.
