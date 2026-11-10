# Agent Note: Group Webhook DAO Database Fixtures

Status: implemented

## Problem

Webhook DAO tests repeatedly create a schema, initialize the complete PostgreSQL
format and establish connections before preparing the same domain facts. Their
queries, commits and independent readers need a known initial data state, while
catalog creation and destruction repeat for each ordinary case. Historical
migration probes, permanent catalog faults and custom concurrent lifetimes also
exist, so fixture sharing needs an explicit boundary.

## Decision

Schema-stable DAO cases run in four sequential parent groups for capture and
admission, delivery, history, and retention. Each parent owns one schema and one
native `pgx.Conn`. The existing domain-fact builder borrows that connection and
retains its real inserts and capture commit. It does not initialize or close the
environment. Cases sharing an intentional committed progression retain their
original order; only former independent fixture boundaries trigger a reset.

Each group captures the complete rows of the migration ledger and four snapshot
seed tables before preparing case facts. The seed rows must remain identical
after each case, including the final case. Before another case, the package-local
reset truncates all other tables together without cascading, restores every
sequence's captured `last_value` and `is_called`, commits, and reads those
sequence states back. Standalone sequences require explicit restoration because
`TRUNCATE RESTART IDENTITY` only restores table-owned sequences. Sequence changes
are not transactionally undone, so a failed reset stops the group.

The release guard executes after case defers and case-owned cleanup. It requires
the native connection to remain open, non-busy and outside a transaction, then
waits with a deadline for auxiliary backends with the schema's application name
to exit. Cases still cancel and join their own workers; backend disappearance
alone cannot prove that a goroutine has stopped. A case, reset, seed or cleanup
failure prevents reuse. The parent closes its connection before schema deletion
and reports close errors.

Historical migration tests, the empty-schema source guard, external management
faults with persistent DDL, the long capture and claim workflows, and the custom
retention-deletion matrix keep independent environments. Transactional fault DDL
in grouped cases still rolls back before the release guard. The reset restores
data for the audited case set; it does not promise to undo arbitrary catalog or
session changes. Groups do not enter parallel scheduling.

Actual SQL constraints, 65,536/65,537-byte capture inputs, the 500-row retention
boundary, independent readers, snapshots, row locks, cancellation and natural
database-clock transitions remain real. The related
[Task grouping decision](2026-11-10-task-dao-group-fixtures.md) records pool-owned
case groups; the [root preparation decision](2026-11-08-postgres-test-preparation.md)
continues to own management-pool reuse and bounded root-package parallelism.

## Alternatives

**One schema per original fixture.** This retains independent catalog state but
repeats initialization and destruction when only data needs restoration.

**A package-wide environment or a generic Store fixture.** Package-wide mutable
state couples unrelated selection and lifetimes. Internal Webhook tests already
exercise native connections; importing their implementation root would also form
a test dependency cycle. Explicit parent groups keep that ownership local.

**An outer rollback transaction per case.** Independent writers and production
transactions commit and must be visible across connections. An outer transaction
cannot replace those mechanisms or reliably undo their work.

**Reset only fixture UUIDs or restore arbitrary DDL.** Cases insert additional
identities, grants, captures and deliveries beyond the builder's return values.
Truncating all mutable tables restores those facts without a second data model.
Permanent DDL faults remain independent because data reset cannot restore relation
identities, triggers or removed tables.

## Consequences

Ordinary groups reduce repeated catalog and connection work at the cost of data
reset, complete seed comparison and bounded release observation. Final-case
cleanup is checked even when no later reset would reveal a leak. Reset and final
schema destruction remain part of measured execution cost.

Fail-stop reuse can suppress later cases after a failure, preserving the original
failure and avoiding misleading results against unverified state. Cases remain
individually selectable and repeatable; temporary reversed-registration runs
verify ordering independence. Original-to-grouped case mapping, matched fault
controls and source-bound measurements determine preserved detection and actual
savings. Package measurements do not establish whole-job CI improvement.
