# Agent Note: Share Project Service Matrix Schemas

Status: implemented

## Problem

The Project direct-member credential and lock-order matrices repeatedly create
and migrate PostgreSQL schemas. Their cases exercise real authorization,
transactions and persisted results, but operate on independent business rows.
Repeated schema initialization adds cost to the complete service package.

## Decision

Each of the OAuth binding, credential revocation, direct/team lock-order, real
team competition and real transfer competition matrices owns one Store and
schema for sequential cases. Each case constructs a fresh fixture and distinct
users, credentials, Teams, Projects and membership records. A failed child
stops further use of that schema. Lock observers use the Store's schema-specific
application name; background operations are cancelled, locks released and
workers joined before a case returns. The independent fixture remains available
to other tests, including the credential-expiry test.

## Alternatives

**Keep a schema per case.** This isolates all rows but repeats migrations and
schema cleanup for each case despite their separate business identities.

**Reset all tables between cases.** This adds reset and verification work where
the cases use independent identities and do not perform schema-wide mutation.

## Consequences

The five matrices retain real transactions, lock ordering, refusals and durable
readback while replacing fifteen schema initializations with five. Rows remain
until the parent drops its schema; new schema-wide behavior or uniqueness rules
require reassessing isolation. Fewer initializations alone do not establish an
improvement in hosted job time.
