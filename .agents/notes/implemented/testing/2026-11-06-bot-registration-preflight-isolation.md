# Agent Note: Bot Registration Preflight Isolation

Status: implemented

## Problem

Malformed configuration and registration-shape tests created a bound-service
fixture even though `RegisterBot` rejects those inputs before entering its
runner. Two fixtures supplied 18 mutation rows, while a mixed test also verified
frozen configuration, versions, authority and credential expiry against actual
stored Bot state. Its initial split had to preserve the no-partial-binding and
authorization observations while removing unnecessary preflight setup.

## Decision

The ten malformed configuration rows and eight registration/role preflight rows
use valid synthetic registration and the existing runner injection boundary.
The baseline includes canonical identities, supported configuration, frozen-role
revision and digest, and valid independent Test Session registration fields.
Every invalid row rejects before runner entry; unexpected entry fails immediately.
A valid-input sentinel checks context, principal, Worker/Bot IDs, callbacks and
one entry, retaining its original operational cause.

The initial PostgreSQL frozen-configuration fixture submitted an invalid input
and read back zero created Sessions, unchanged Bot version and unbound
role/Session state before continuing its frozen configuration, version,
membership, PAT kind and expiry sequence. Valid arguments, backend recovery and
concurrent binding still used the real database at that time.

The [complete Session isolation decision](2026-11-08-session-test-dao-mocks.md)
replaces that partial allocation. Session core tests control frozen Bot,
credential and Session facts through narrow DAO and runner dependencies and
check proposed binding arguments and completion. Store witnesses own real
atomic binding, preference, version and persistence mechanisms; service tests
own cross-module coordination. The
[test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns current usage. No persistence simulator is added.

## Alternatives

**Keep PostgreSQL for every preflight matrix.** It supplies no different oracle
for input syntax that never enters the runner and makes rule edits depend on
database preparation.

**Replace the mixed test with a mock as well.** At the initial split, this would
have removed actual frozen binding, version, membership and credential-expiry
observations. The database tail retained those facts; complete isolation supplies
explicit DAO facts and keeps database mechanisms in Store tests.

**Drop the no-partial-binding observation.** A runner-not-entered expectation
proves unit ordering, but the original durable observation was also valuable.
The initial fixture retained it before subsequent operations; Store witnesses
retain the real write/rollback mechanism under complete isolation.

## Consequences

The initial preflight split retained one shared PostgreSQL fixture rather than
two; its 18 input rows were never 18 independent setups. That historical count
does not describe the current complete Session suite. Positive runner entry
prevents invalid digest or identity facts from making every refusal vacuous.

Some mutations invalidate related frozen-role facts together, as in the original
inputs; their names do not establish independent predicate coverage. Actual
fault probes and source-bound records own retained-proof and performance claims.
Scoped feedback improvements do not establish whole-job or hosted CI savings.
