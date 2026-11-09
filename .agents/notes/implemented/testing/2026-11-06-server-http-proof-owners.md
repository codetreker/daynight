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

The original consolidation placed shared HTTP scenario bodies with their domain
owner and retained root cases requiring private composition access. It preserved
production fixtures, resource ownership and independent observations while
removing repeated execution. That decision did not establish the current
non-Store dependency policy. The
[Go dependency decision](2026-11-08-go-test-dependency-boundaries.md),
[root DAO ownership decision](2026-11-09-root-http-test-dao-ownership.md) and
[Session use-case decision](2026-11-09-session-http-use-cases.md) replace their
respective fixture dependencies. The
[test-writing rules](../../../../docs/writing_tests.md) own responsibility and
integration restrictions.

Task and Session HTTP units control directly called service/use-case results
while retaining actual credential middleware, HTTP encoding, response loss and
resource or socket observations. Session tests use typed operation callbacks
and opaque archive capabilities, with actual published frames, Ping/Pong,
backpressure, cancellation and drain. Service, Core and Store tests retain their
lower orchestration, rule and physical mechanisms. The
[Session protocol decision](2026-11-07-session-protocol-test-completion.md)
preserves the initial cursor, permission and ping corrections.

Root composition and domain protocol cases remain separate when they observe
different preparation, behavior or dependencies. Root tests retain relay
shutdown before dependency release, independently bound terminal recovery,
startup, native serialization and channel regressions. Their HTTP control and
WebSocket traffic share one actual application and Engine; strict DAO plans
supply persistence inputs and independent proposed-write/completion facts.
Actual SQL, lock waits, database-clock expiry and committed readback remain
with Store tests; complete entry-point drain and restart persistence remain
with process tests. UniAuth result/browser binding and SDK wire-loss tests keep
their actual isolated gateway, proxy and sockets.

Normal assembled API flows use the explicit production process integration
runner. `TestServerAPINormalFlows` owns normal Task-related groups;
`TestServerAPISessionNormalFlow` owns Session registration/grant, Controller
synchronization, HTTP/browser identity readback and exact event content over
WebSocket. Boundary, fault, response-loss and concurrency matrices stay with
their actual protocol, service/Core, Store or runtime owners.

Shared scenario bodies have one owner. Distinct root composition and domain
adapter observations retain their own tests. The
[server validation guide](../../../../packages/daynight-server/README.md#http-scenario-ownership)
owns commands and resource boundaries. Consolidation retained production
behavior, package discovery, race policy and coverage gates in force at that
time; the [Go module coverage decision](2026-11-06-go-module-coverage-boundary.md)
describes the coverage boundary.

## Alternatives

**Retain complete copies in both packages.** At the initial consolidation, both
fixture families invoked the same production composition. Duplicate database
and authentication work added no independent HTTP implementation or oracle.

**Delete every root Session and terminal test.** That would remove private
runtime dependency ordering and independently prepared recovery observations,
along with helpers used by root-only regressions. Distinct observations had to
survive consolidation.

## Consequences

The original consolidation reduced repeated fixture and scenario execution
while preserving product behavior and the actual mechanisms being tested.
Later Task and Session HTTP isolation move their collaborators to direct lower
operations; root composition isolation supplies strict DAO facts while retaining
actual modules and runtime mechanisms. Logical, protocol, physical storage and
normal full-application observations retain separate owners. A historical
reduction of duplicate bodies does not require full-application preparation for
every HTTP assertion.

Root and domain packages retain independent cases and can execute concurrently.
Compilation, remaining fixtures and receiving proof owners still incur cost,
so fewer copies do not establish a whole-job speedup. Source-bound evidence
owns actual timing and retained-proof comparisons. A second copy belongs in
another package only when it provides a distinct observable regression.
