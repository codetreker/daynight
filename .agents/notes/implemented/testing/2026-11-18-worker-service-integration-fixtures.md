# Agent Note: Worker Service Integration Fixture Lifetime

Status: implemented

## Problem

The Worker snapshot, read-only OAuth and report capacity service tests each
repeat schema and pool preparation for two related scenarios. Those scenarios
observe real commits, authorization changes, clocks, pagination and rollback.
Each body's state already belongs to distinct owners and Workers, so repeating
the schema adds setup cost without increasing the independence of its data.

## Decision

Each test group owns one isolated PostgreSQL schema and pool. Its scenarios
run sequentially with distinct owners, credentials and Worker IDs. The
snapshot tests retain unknown, empty and stale inventory, owner isolation,
heartbeats between pages, cross-owner cursor refusal, liveness clocks and
expiry. Scenario SQL that changes a Worker filters by owner and Worker ID.

The OAuth delivery and return cases use separate owners, Worker PATs, valid
and revoked OAuth families, and synchronization gates. Each case cancels the
request context, closes its broker and joins every request goroutine before
the next case or parent teardown. The revocation, unaffected OAuth family and
still-live Worker PAT remain observed through real authorization reads.

The report capacity cases retain the exact large merged snapshot and
configuration observation inputs. Complete row JSON before and after each
rejection verifies rollback. The stale observation case still reports with
an unaccepted configuration observation. [Worker service refusal fixtures](2026-11-18-worker-service-refusal-fixtures.md)

## Alternatives

**Use separate schemas for every physical scenario.** This repeats schema
initialization for state already scoped by owner, credential and Worker ID.
The grouped tests retain physical operations and same-scenario SQL readback.

**Share one schema across the package.** A wider lifetime would couple
unrelated tests and their cleanup. Separate parent ownership limits shared
resources to the scenarios with matching storage and identity assumptions.

## Consequences

The six scenarios use three isolated schema and pool lifetimes. They retain
their real infrastructure requirements. Each scenario can run through its own
subtest selector, and asynchronous OAuth work finishes before the shared
database can be reused or closed.
