# Agent Note: Share Session Service Matrix Schemas

Status: implemented

## Problem

The Session service completion and Bot media recovery matrices repeatedly create
and drop a full PostgreSQL schema. Their cases require real transactions and
persisted observations, but each case changes ordinary rows rather than the
schema. Repeated initialization increases the cost of exercising all outcomes.

## Decision

Each matrix owns one Store and schema for its sequential cases. Each case creates
its own identity, credentials, Session and Engine; the Bot matrix also creates
its own Project, Task, Worker, Bot and file storage. The existing independent
service fixture continues to own a separate Store for other callers. Child
cleanups stop the Engines and close file storage before the parent closes the
Store and drops the schema. A failed child stops further reuse.

Media recovery scans leases across the schema, so the parent verifies that no
leases remain after each child before reusing its Store. Fixed native Session IDs
are scoped by the independently created owner; other unique identifiers and
PAT and Controller token hashes are generated per case. Assertions read the relevant Session
and its resources. This approach differs from the
[Session Store reset fixtures](2026-11-11-session-store-group-fixtures.md):
committed rows remain until schema cleanup because the cases own disjoint data.

## Alternatives

**Keep a schema per case.** This avoids shared rows, but repeats schema setup and
cleanup for every combination.

**Reset all tables between cases.** This would add reset and seed verification
work even though the cases use independent identities and the only schema-wide
recovery input is explicitly checked for emptiness.

## Consequences

The matrices retain real transaction completion, durable readback and file
resource behavior while avoiding six schema initializations. Case data remains
in the parent schema until cleanup, and additions to schema-wide queries or
uniqueness constraints require reassessing isolation. The parent stops on child
or lease-check failure; independent child selection still runs the same fixture
and assertions. Fewer initializations alone do not establish hosted CI savings.
