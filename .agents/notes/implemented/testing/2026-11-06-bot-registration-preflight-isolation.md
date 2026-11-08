# Agent Note: Bot Registration Preflight Isolation

Status: implemented

## Problem

Malformed configuration and registration-shape tests created a bound-service
fixture even though `RegisterBot` rejects those inputs before entering its
runner. Two fixtures supplied 18 mutation rows, while a mixed test also verified
frozen configuration, versions, authority and credential expiry against actual
stored Bot state. Removing the database work indiscriminately would lose its
no-partial-binding and authorization oracles.

## Decision

The ten malformed configuration rows and eight registration/role preflight rows
use a valid synthetic registration and the existing runner injection boundary.
The baseline includes canonical identities, supported configuration, frozen-role
revision and digest, and valid independent Test Session registration fields.
Every invalid row rejects before runner entry; unexpected entry fails immediately.
A valid-input sentinel checks context, principal, Worker/Bot IDs, callbacks and
one entry, retaining its original operational cause.

The existing PostgreSQL frozen-configuration fixture first submits one invalid
configuration and reads back zero created Sessions, unchanged Bot version and
unbound role/Session state. Only after that strict barrier does the original
frozen configuration, stored version, membership, PAT kind and expiry sequence
continue. Valid configuration/arguments, backend error recovery and concurrent
binding tests retain their real database behavior.

The [test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns the shared unit and integration policy. No production API or persistence
simulator is added. Pre-storage rules use the actual existing runner boundary;
rules needing stored facts retain DAO contracts or real integration as required.

## Alternatives

**Keep PostgreSQL for every preflight matrix.** It supplies no different oracle
for input syntax that never enters the runner, and makes those rule edits depend
on database preparation.

**Replace the mixed test with a mock as well.** That would remove actual frozen
binding, version, membership and credential-expiry facts. Its PG tail remains.

**Drop the no-partial-binding readback.** A runner-not-entered expectation proves
ordering in a unit case, but the original database observation remains valuable.
It is retained at the start of the existing unbound fixture, and must confirm
unchanged state before subsequent operations.

## Consequences

The full preflight scope retains one shared PG fixture rather than two; the 18
input rows never represented 18 independent setups. Pure selections run without
a database URL, and a positive runner entry prevents invalid digest or identity
facts from making every refusal vacuous.

Some mutations invalidate related frozen-role facts together, as in the original
inputs; their names do not establish independent predicate coverage. Actual
fault probes and source-bound records own retained-proof and performance claims.
Scoped feedback improvements do not establish whole-job or hosted CI savings.
