# Agent Note: Session Archive Read Fixtures

Status: implemented

## Problem

The archive admission and terminal read error tests prepared a full Session
fixture with identities, claims, and persisted files. Their assertions concern
authorization order and the errors reported when a scoped read fails.

## Decision

Controlled transaction scopes supply the credential, Project visibility and
terminal query outcomes to the real Service and Core code. Archive admission
checks authorization before looking up the Session. The nonmember cases never
read metadata. An authorized missing row still travels through the real
transaction error mapping and HTTP error classification.

The Store suite checks the actual PostgreSQL missing row, its driver cause,
transaction rollback, and reuse of the only connection. Existing terminal
history tests retain persisted content and revocation behavior.

## Alternatives

**Keep the database and terminal history fixtures for every failure.** This
would repeat persistence setup for errors that are injected before a file read.

**Stub the public archive or terminal operations.** That would remove the
authorization ordering and the transaction error handling under test.

## Consequences

The two failure tests run without PostgreSQL. Real database and file
mechanisms retain their existing owners and isolation requirements.
