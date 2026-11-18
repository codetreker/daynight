# Agent Note: Auth Request and Profile Cache Fixtures

Status: implemented

## Problem

The request authentication and profile cache cases started UniAuth and created
PostgreSQL identities to obtain known credential and user facts. The
assertions cover the HTTP adapter's choice of credential, admission, response
identity, and profile representation validation.

## Decision

Controlled identity operations supply exact credential and user results.
The real HTTP adapter parses headers and cookies, checks Origin and
credential precedence, and admits the caller before writing the authenticated
identity or checking an entity tag. The cache cases use complete profiles,
including nullable and large fields, and apply successive query results
explicitly. A refusal or failed profile read cannot validate cached content.

Physical tests retain actual issuance, revocation, expiration and profile
persistence. The Store suite checks the real missing-user and database query
errors independently of the HTTP response mapping.

## Alternatives

**Keep the complete login setup for HTTP cases.** This would exercise the
identity lifecycle again to obtain fixed facts for the HTTP assertions.
The actual login and credential lifecycle tests already verify the stored
effects.

**Substitute the authenticated route.** That would remove the HTTP behavior
under test, including the distinction between an admitted actor and the
untrusted header and credential values sent by a request.

## Consequences

The six selected HTTP scenarios run without a database or gateway. Actual
identity and storage mechanisms retain their existing PostgreSQL witnesses.
