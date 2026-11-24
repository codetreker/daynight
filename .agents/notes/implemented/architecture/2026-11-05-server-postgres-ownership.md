# Agent Note: Server PostgreSQL Ownership

Status: implemented

## Problem

Data-access contracts and PostgreSQL implementation details shared the store
root. Domain consumers could therefore acquire driver types or concrete
transactions, and moving individual DAOs risked splitting one logical operation
across different database transactions. Migration checksums also identify
historical code as well as SQL, so moving source can invalidate existing databases.

## Decision

`core/store` owns database-neutral DAO, scope, transaction and completion
contracts. The sole SQL backend is `core/store/postgres`: its root assembles
transaction scopes, domain packages implement their DAOs, and `postgres/internal`
owns shared query and scanning mechanisms. Every DAO in a scope binds to the same
transaction; read scopes use one read-only Repeatable Read snapshot. The
[snapshot reader decision](2026-11-05-server-snapshot-readers.md) retains the
reason for callback-limited readers and explicit completion facts.

`service/persistence.go` selects the backend and provides transactions,
readiness and close operations to runtime composition. Offline attachment
maintenance obtains a separate dedicated connection and retains its advisory lock
for the operation. Driver failures are mapped to neutral facts while preserving
their original causes; cleanup failures and unknown completion remain distinct
from business refusals.

The current snapshot and migration artifacts share the `postgres/schema` entry
point. The original relocation brought 026 and 083 into dedicated leaf packages
without changing their SQL or transform bytes and preserved Worker tag-filter
migration 082's published identity. The
[099 baseline decision](2026-11-24-postgres-migration-baseline.md)
replaces that executable prefix with a baseline and the original checksums.
Subsequent SQL stays in `schema/migrations`; migrations with frozen Go transforms
retain dedicated leaf packages whose registration preserves the exact bytes.
The [Team repository uniqueness decision](2026-11-18-team-project-repository-uniqueness.md)
owns migration 083's rules and frozen identity source.

## Alternatives

**Keep the concrete implementation in the store root.** This avoids moving
files but leaves domain contracts coupled to the driver and obscures which
capabilities share a transaction.

**Retain forwarding entry points or aliases at the old location.** These would
keep the former concrete dependency available to consumers and perpetuate two
apparent owners for one implementation.

**Keep history separate from the snapshot.** This preserves the former layout,
but requires maintainers to find the current format and its source history in
different directories.

## Consequences

Runtime and business consumers depend on contracts, while backend code owns SQL,
scans, connection management and migration registration. Splitting DAOs requires
explicit composition of their shared transaction and preserves existing lock
ordering. Frozen transform source carries its original package declaration because its
exact bytes participate in the installed checksum. At the original relocation,
preserving the bytes let existing ledgers validate without a database change.
