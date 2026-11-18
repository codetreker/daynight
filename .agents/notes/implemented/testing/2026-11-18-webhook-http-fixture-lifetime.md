# Agent Note: Webhook HTTP Fixture Lifetime

Status: implemented

## Problem

The Webhook HTTP configuration and committed-write tests repeatedly create the
same PostgreSQL schema, pool and base listener. Their request and readback
assertions use distinct owners, endpoints and operation IDs. The expensive
fixture preparation is repeated even within pairs of cases that can safely
share the same database and listener.

## Decision

The owner CRUD and byte-boundary cases run as sequential children in the
configuration lifecycle test. The response-loss and post-commit authorization
groups also each open one fixture in their parent. These three parent tests
own their schema, pool and base listener. Every child has its own thirty-second
context and fresh actor, credential, owner and operation data. The assertions
read only scenario-owned rows, so the groups need no data reset between
children. [Webhook DAO fixture decision](2026-11-10-webhook-dao-group-fixtures.md)

Response-loss injection retains a case-local writer, production router and
logger. The authorization-change cases retain a case-local post-commit gate,
logger and real HTTP listener. Child cleanup releases the gate, closes that
listener and joins its client before the next scenario. Production
authentication, parsing, transaction execution, receipt recovery and
independent SQL verification remain in the tests.

## Alternatives

**Create a fresh schema and base listener for every case.** This makes isolation
independent of query scopes but repeats migrations and resource setup. The
grouped cases already scope data and checks to their own actors and IDs.

**Share a fixture across the package.** Schema-wide failure injection and
other cases have different lifetime requirements. Restricting reuse to three
parents keeps those mechanisms independent and lets each parent own teardown.

## Consequences

The selected cases use three schema and base listener lifecycles across the
three test groups. Their setup still requires an isolated PostgreSQL database.
Cases involving schema mutations, history, physical COMMIT acknowledgement
loss or concurrent transaction locks retain their own infrastructure.
