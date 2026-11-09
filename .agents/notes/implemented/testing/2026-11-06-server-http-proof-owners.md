# Agent Note: Server HTTP Scenario Ownership

Status: implemented

## Problem

The root HTTP package and its Bot and Session domain packages contained copies
of the same integration scenarios. Both constructed the production application
and prepared real PostgreSQL schemas, UniAuth identities and credentials.
Running the copies repeated database, authentication and protocol work without
adding a different application boundary. Some root tests also used private
application state, so deleting root files as a group would lose independent
assertions.

## Decision

The original consolidation placed shared HTTP scenario bodies with their domain
owner and retained root cases requiring private composition access. It preserved
production fixtures, resource ownership and independent observations while
removing repeated execution. That decision did not establish the current
non-Store dependency policy. The later
[root DAO ownership decision](2026-11-09-root-http-test-dao-ownership.md)
replaces root database-backed preparation with strict DAO facts and retains
physical evidence in Store and process tests. The
[test-writing rules](../../../../docs/writing_tests.md) own dependency restrictions.

Root composition and domain protocol cases remain separate when they observe
different state preparation, behavior or dependencies. Shared scenario bodies
have one owner. Root tests retain relay shutdown before dependency release,
independently bound terminal recovery, startup, native serialization and channel
regressions. Their HTTP control and WebSocket traffic share one actual application
and Engine; explicit DAO plans provide their persistence inputs.

The domain browser ping regression uses a focused production Session adapter
with a local interval. Its actual protocol completion and cleanup are described
by the [Session test completion decision](2026-11-07-session-protocol-test-completion.md).
The [server validation guide](../../../../packages/daynight-server/README.md#http-scenario-ownership)
owns the current layout. The original consolidation preserved the production
behavior, package discovery, race policy and coverage gates in force at that
time; the [Go module coverage decision](2026-11-06-go-module-coverage-boundary.md)
describes the coverage boundary.

## Alternatives

**Retain complete copies in both packages.** Both fixture families invoked the
same production composition, so duplicate database and authentication work added
no independent HTTP implementation or oracle.

**Delete every root Session and terminal test.** This would remove private
runtime dependency ordering and independently prepared recovery readback, along
with helpers used by root-only regressions. Distinct observations had to survive
consolidation.

## Consequences

The original consolidation reduced repeated fixture and scenario execution
without changing product behavior or replacing the mechanisms being tested.
Root and domain packages retained independent cases and could execute
concurrently. Compilation, remaining fixtures and other packages still incurred
cost, so fewer copies did not establish a whole-job speedup.

The later root dependency correction preserves the one-owner rule while
separating protocol and composition observations from SQL and committed
readback. Source-bound evidence owns actual timing and retained-proof
comparisons. A second copy belongs in another package only when it provides a
distinct observable regression.
