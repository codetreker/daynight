# Agent Note: Construct Only Exercised Go Test Fixtures

Status: implemented

## Problem

Some service tests create a complete PostgreSQL project and identity fixture only
to supply a principal for input rejection that happens before storage. Graph and
Sync projection tests write large descriptions before replacing the description
column with a failing expression, so the stored bytes cannot affect the queried
projection. Bot creation tests also issue 235 separate inserts to prepare two
otherwise uniform Worker sets.

A Webhook eligibility rollback matrix also initializes a new schema for each
source operation even though its failure phase is unchanged and each row owns
separate users, teams, projects and subscriptions.

These setup operations add schema, JSON, SQL round-trip and cleanup work without
strengthening the behavior the corresponding assertion observes. The
[request-validation decision](2026-11-06-project-request-validation-isolation.md)
records the existing fail-on-access fixture used for Project input checks.

## Decision

Attachment input rejection uses a synthetic authenticated principal with nil
dependencies. Project settings and invalid page budgets use the existing
validation fixture, whose storage entry points fail if called. Identity service
admission tests supply explicit lower refusals and require no transaction or
upstream request. Core Identity tests own the original provider and return-path
matrix. Browser-scope rejection and SDK callback configuration execute in the
service adapter; Store Identity tests own persisted login fields and serialized
admission. The [Identity operation ownership decision](2026-11-09-identity-direct-operation-tests.md)
records this allocation, including real SDK transport and scope completion.

Graph and Sync store tests retain their failing description expressions, scoped
data, Unicode previews, versions, dependency fields and snapshot/time boundaries
while omitting inaccessible description blobs. An unintended description
selection still raises a PostgreSQL exception. These physical projection
witnesses originally shared service fixtures; the
[Task service ownership decision](2026-11-08-task-service-test-ownership.md)
places them with the DAO implementation and uses explicit query results for
service coordination.

Bot creation fixtures insert the same 130 expired malformed Workers and 105 active
Workers with two set-based statements. The active set retains distinct ascending
creation times, the original telemetry, and the selected-worker ordering and
101-candidate boundary. Full historical decoding must still fail, while bounded
candidate reads return the intended fields.

Before the
[Webhook service test ownership decision](2026-11-08-webhook-service-dao-mocks.md),
the eligibility rollback matrix initialized one schema per failure phase and ran
source rows sequentially. Each row created independent principals, teams,
projects, invitations and subscriptions, retaining native SQL or row-scan errors, source rollback and
unchanged authorization readback. The nullable epoch alteration belonged to its
phase's schema. The 26 source/failure combinations used four schemas without
sharing mutable business owners. Current Webhook service cases use DAO mocks;
source-producing services and PostgreSQL transaction tests own the corresponding
producer and physical rollback proofs.

## Alternatives

**Keep full database fixtures for input-only tests.** Schema initialization and
identity persistence supply facts that a synthetic valid principal already
expresses. Existing integration cases retain storage, authorization and no-write
readback where those mechanisms are the proof.

**Keep large descriptions beneath the failing views.** Those values are never
read through the view. The PostgreSQL exception is the direct guard against
selecting description, independently of the source value's size.

**Reduce the Worker counts.** That would stop exercising the expired directory
and active selection boundary. Set-based inserts retain those counts and malformed
inputs while removing repeated client/server round trips.

**Reuse every mutable schema.** Destructive and concurrent tests need independent
owners and cleanup. These changes omit irrelevant construction and batch uniform
data; they do not change the default schema isolation or migration mechanism.

## Consequences

The targeted input-only selections execute without a database URL, and their
storage sentinels still reject accidental dependency access. Layer-owned
integration tests retain transactions, rollback, permissions and persistence
observations. The Webhook and Task service ownership decisions record the later
replacement of their database-backed rule and coordination matrices. Graph and
Sync SQL projection witnesses live in store tests; Bot admission boundaries
retain native PostgreSQL behavior.

The change removes unused setup and preserves fixture row counts; its effect on
package and complete CI elapsed time requires matching source, race, coverage,
cache and resource conditions. Coverage totals or fewer inserts alone do not
establish preserved behavior or faster hosted CI.
