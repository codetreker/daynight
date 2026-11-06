# Agent Note: Server HTTP Scenario Ownership

Status: implemented

## Problem

The root HTTP package and its Bot and Session domain packages contain copies of
the same integration scenarios. Both construct the production application and
prepare real PostgreSQL schemas, UniAuth identities and credentials. Running
the copies repeats database, authentication and protocol work without adding a
different application boundary. Some root tests also use private application
state, so deleting root files as a group would lose independent assertions.

## Decision

Domain packages own shared HTTP integration scenarios, including registration,
strict input and authentication refusals, response-loss reconciliation,
WebSocket transitions and archive readback. Their fixtures keep the production
application, real database and UniAuth boundary. Mutable state and cleanup
remain local to each test.

The root package retains scenarios that require private composition access:
runtime relay shutdown before dependency release and automation-recovery
preparation through an independently bound terminal connection. Its shared
Session fixture remains available to startup, native serialization, channel
regression and MCP shutdown tests. The domain suite retains the real ping/pong
and subsequent-event regression and its additional automation-recovery refusal
cases.

Shared scenario bodies have one owner. Root composition and domain protocol
tests remain separate when they exercise different state preparation,
observations or dependencies. The [server validation guide](../../../../packages/daynight-server/README.md#http-scenario-ownership)
owns the test layout. Consolidation retained the production behavior, package
discovery, race policy and coverage gates in force at that time. The
[Go module coverage decision](2026-11-06-go-module-coverage-boundary.md)
describes the current check.

## Alternatives

**Retain complete copies in both packages.** Both fixture families invoke the
same production composition, so the duplicate database and authentication work
adds no independent HTTP implementation or oracle.

**Delete every root Session and terminal test.** This would remove private
runtime dependency-ordering and independently prepared recovery readback
assertions, as well as helpers used by root-only regressions. Those tests and
their required fixtures remain in the root package.

## Consequences

Shared HTTP scenarios prepare their database and authentication fixtures once
per case. Consolidation preserves the retained scenario bodies and their
failure, ordering, cancellation, isolation and cleanup assertions. It reduces
repeated execution without changing the product or replacing real I/O with
mocks.

The root and domain packages still contain independent scenarios and can run
concurrently. Compilation, remaining fixtures and other packages still cost
time, so removing duplicate cases does not establish a whole-job or overall CI
speedup. Source-bound validation records own measured costs and retained-proof
comparisons. A new copy belongs in a second package only when it provides a
distinct observable regression.
