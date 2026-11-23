# Agent Note: Worker Active Claim Index

Status: implemented

## Problem

Worker inventories scan complete candidate Tasks and decode their claim properties
before selecting a page. An account with no claims can still pay for the entire
candidate set. A schema change must preserve exact historical text comparisons,
opaque non-Worker properties and a restartable recovery build.

## Decision

Keep the Worker property as the only claim authority. Migration 115 installs a
nonunique partial B-tree over exact C-collated account and Worker text plus Task
ID, limited to active Worker rows. CASE guards prevent other property values from
entering JSONB conversion. The existing inventory reader remains available in
this schema-compatible build.

A SHARE table lock covers frozen stored-claim validation, comparison with actual
PostgreSQL extraction, index creation and migration-ledger insertion. Frozen
source and DDL participate in the checksum. Historical Herdr and completed claims
are checked without current new-claim admission rules. Invalid data fails with
its Task ID and preserves transaction rollback and the original cause.

The [index design](../../../../docs/design/worker-active-claim-index.md) owns exact
expressions, deployment budgets, source-bound verification and ledger/index
reconciliation after uncertain startup outcomes.

## Alternatives

**Create an independent claim table.** That requires moving historical claims and
switching every lifecycle and Session consumer. Candidate lookup can use the
existing authority without that separate modeling change.

**Cast claim identifiers to UUID.** PostgreSQL normalizes hexadecimal case,
changing the existing Go reader's exact string comparison. C-collated text keeps
the established behavior.

**Build the index without a frozen preflight.** JSONB extraction can reject
historical values or interpret fields differently from Go decoding. Holding the
lock through validation and DDL prevents a writer from invalidating the checked
population before commit.

**Switch the query in the same delivery.** Separating the schema transition
preserves a build that understands the new ledger while retaining the existing
read path. This gives query rollback a concrete artifact and separates migration
startup cost from query behavior and performance.

## Consequences

Active claim changes maintain an additional index. Migration blocks attribute
writes while permitting ordinary reads, and full-population validation and index
construction contribute to startup time. Representative deployment rehearsal
must include lock contention and the configured startup budget.

Task versions, timestamps, Sync epochs and raw properties survive unchanged.
Bootstrap and upgrade share the same final index and ledger checksums. After
commit, older binaries reject the unknown ledger; recovery uses the same-ledger
build or a forward migration. This delivery supplies the index and recovery
build; query performance benefits require the separate inventory query change.
