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
validation fixture, whose storage entry points fail if called. Identity's invalid
login scope, provider and return-path matrix uses an unavailable writer and no
upstream client; every input must still produce the expected domain fault without
opening a transaction. A real Identity integration test retains rejected-scope
zero-row readback, accepted return paths and upstream callback configuration.

Graph and Sync tests retain their failing description expressions, scoped data,
Unicode previews, versions, dependency fields and snapshot/time boundaries, while
omitting the inaccessible description blobs. An unintended description selection
still raises a PostgreSQL exception.

Bot creation fixtures insert the same 130 expired malformed Workers and 105 active
Workers with two set-based statements. The active set retains distinct ascending
creation times, the original telemetry, and the selected-worker ordering and
101-candidate boundary. Full historical decoding must still fail, while bounded
candidate reads return the intended fields.

The Webhook eligibility rollback matrix initializes one schema per failure phase
and runs source rows sequentially. Each row creates independent principals, teams,
projects, invitations and subscriptions, and retains native SQL or row-scan errors,
source rollback and unchanged authorization readback. The row-scan phase's nullable
epoch alteration belongs to that phase's schema and cannot affect the other
phases. The 26 source/failure combinations use four schemas without resetting or
sharing mutable business owners.

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
storage sentinels still reject accidental dependency access. Real integration
tests retain transactions, rollback, permissions and persistence observations.
The Graph and Sync SQL projection and Bot admission boundaries remain native
PostgreSQL behavior.

The change removes unused setup and preserves fixture row counts; its effect on
package and complete CI elapsed time requires matching source, race, coverage,
cache and resource conditions. Coverage totals or fewer inserts alone do not
establish preserved behavior or faster hosted CI.
