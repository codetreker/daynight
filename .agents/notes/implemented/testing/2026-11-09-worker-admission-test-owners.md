# Agent Note: Worker Admission Test Owners

Status: implemented

## Problem

Worker admission tests combined service orchestration, Core capacity decisions,
PostgreSQL owner locks and transaction readback in complete database fixtures.
Fixed principals and report facts required identity and Project preparation.
A failure could therefore depend on several owners, and replacing only the
service fixture would lose real locking or rollback observations.

## Decision

Worker report services bind their directly invoked Core operations per instance.
Production constructors select the real validator, configuration parser,
admission decision, task matcher, snapshot projection and configuration exchange.
Service admission tests supply those results and execute the real report callback
with strict scope, DAO and completion controls. Exact context, principal, IDs,
arguments and call order remain observed; proposed snapshots and DAO results are
independent data. Service-owned JSON and protocol encoding still execute.

Core admission tests retain the complete 99/100/101 decision matrix, including
missing target timestamps, the 120-second default and exact active-window
boundaries. Snapshot projection uses the locked observation rather than the
future client sample time. PostgreSQL
Worker tests own actual counts, target timestamps, canonical owner locking,
post-wait clock samples and expiry. Root Store tests execute `WriteWorker` for
actual completion, rollback, cancellation, SQL failure and persisted readback.
The second concurrent admission observes the first committed row; its supplied
callback refusal does not reimplement the Core capacity decision.

The [test-writing rules](../../../../docs/writing_tests.md) own layer boundaries.
The [Worker test-cost decision](2026-11-08-worker-test-cost.md) preserves the
summary-projection and earlier test-consolidation rationale. Other Worker
configuration, capacity and read-only suites retain their separate responsibilities.

## Alternatives

**Keep the database service fixture.** It repeats identity and Project setup for
controlled service facts and continues executing lower business rules inside the
service proof.

**Move the complete service scenario into Store.** This would retain upper
business decisions in the SQL owner. Direct DAO and scope calls preserve actual
locks and persistence without duplicating capacity decisions.

**Replace the complete scenario with mocks.** Supplied transaction outcomes and
captured writes cannot prove serialization, physical rollback or committed data.

## Consequences

The admission service subset executes without database or authentication fixtures.
Its failure and cancellation paths reject subsequent calls and suppress partial
results, including independent transaction and cleanup failures. Real database
work remains in the appropriate receiving suites. Source-bound measurements must
include their cost; a faster service subset alone does not establish faster CI.
