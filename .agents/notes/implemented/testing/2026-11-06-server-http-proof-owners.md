# Agent Note: Server HTTP Scenario Ownership

Status: implemented

## Problem

The root HTTP package and its Bot and Session domain packages originally
contained copies of the same integration scenarios. Both fixture families
constructed the production application and prepared PostgreSQL schemas,
UniAuth identities and credentials. Running the copies repeated database,
authentication and protocol work without adding a different application
boundary. Some root tests also used private application state, so deleting root
files as a group would have lost independent assertions.

## Decision

Domain packages own shared HTTP scenario bodies, including registration, strict
input and authentication refusals, response-loss reconciliation, WebSocket
transitions and archive readback. A scenario body has one owner. Root composition
and domain protocol tests remain separate when they exercise different state
preparation, observations or dependencies.

The initial consolidation retained full-application fixtures with real database
and UniAuth boundaries. A focused browser ping fixture assembled the Session
adapter with real business services and authentication to use a test-local
interval. Mutable state and cleanup remained local to each test. The
[Session test completion decision](2026-11-07-session-protocol-test-completion.md)
records the protocol and cleanup corrections made with that split.

Task HTTP tests use the direct service/use-case boundary in the
[Go test dependency decision](2026-11-08-go-test-dependency-boundaries.md), which
partially supersedes full-application fixture retention for that suite. Session
HTTP tests use the same responsibility rule through their
[typed use-case binding](2026-11-09-session-http-use-cases.md). Both retain actual
HTTP adaptation and credential middleware with controlled directly called
operations. Session socket tests retain real frames, backpressure, cancellation
and drain, while service, Core and Store tests retain their lower mechanisms.

Normal assembled API flows use the explicit production process integration
runner. `TestServerAPINormalFlows` owns normal Task-related groups;
`TestServerAPISessionNormalFlow` owns Session registration/grant, Controller
synchronization, HTTP/browser identity readback and exact event content over
WebSocket. Fault, boundary and concurrency matrices remain with their actual
protocol, service/Core or Store owners.

The root package retains scenarios needing private composition access, including
runtime relay shutdown before dependency release and automation-recovery
preparation through an independently bound terminal connection. Its own
startup, native serialization, channel and MCP shutdown fixtures remain with
those tests. The domain suite retains real Ping/Pong, subsequent-event delivery
and its additional automation-recovery refusal cases.

The [server validation guide](../../../../packages/daynight-server/README.md#http-scenario-ownership)
owns the layout. Consolidation retained production behavior, package discovery,
race policy and coverage gates in force at that time. The
[Go module coverage decision](2026-11-06-go-module-coverage-boundary.md)
describes the current check.

## Alternatives

**Retain complete copies in both packages.** At the initial consolidation, both
fixture families invoked the same production composition. Duplicate database
and authentication work added no independent HTTP implementation or oracle.

**Delete every root Session and terminal test.** That would remove private
runtime dependency-ordering and independently prepared recovery observations,
as well as helpers used by root-only regressions. Those tests and required
fixtures retain their own composition owner.

## Consequences

Initial consolidation reduced shared full-application scenarios to one database
and authentication setup per case, preserving their failure, ordering,
cancellation, isolation and cleanup observations. Task and Session HTTP unit
isolation move the collaborator boundary to direct lower operations while
retaining actual HTTP and socket mechanisms. Lower rules, physical storage and
normal full-application collaboration have their own owners. A historical
reduction of duplicate bodies does not require full-application preparation for
every HTTP assertion.

Root and domain packages still contain independent scenarios and can run
concurrently. Compilation, remaining fixtures and other packages still cost
time, so removing duplicate cases does not establish a whole-job speedup.
Source-bound validation records own measured costs and retained-proof
comparisons. A new copy belongs in a second package only when it provides a
distinct observable regression.
