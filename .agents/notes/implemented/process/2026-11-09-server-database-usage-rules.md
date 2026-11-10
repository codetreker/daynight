# Agent Note: Server Database Usage Rules

Status: implemented

## Problem

The server organization rules assign SQL and transactions to the DAO backend,
but do not establish which decisions belong in application code or which
constraints justify database enforcement. Business policies can consequently
acquire separate implementations in Go, SQL expressions and schema checks.
Concurrency guidance also needs to distinguish an operation's expected facts
from the particular use of a version column.

## Decision

The [database usage rules](../../../../docs/daynight-server-database.md) own SQL,
constraint, query-cost and concurrency policy. The
[server organization rules](../../../../docs/daynight-server.md) retain their
existing responsibilities and link to that policy. This complements the
[PostgreSQL ownership decision](../architecture/2026-11-05-server-postgres-ownership.md),
which owns backend placement and transaction composition.

Domain code owns business decisions. SQL performs data access, set operations
and the atomic conditions needed to preserve those decisions. Constraints have
specific storage or concurrency purposes; duplicating domain validation is not
sufficient justification for database enforcement.

Optimistic concurrency is preferred and atomically checks the operation's
expected state, field values, version or their combination. A state transition
can compare its expected source state without introducing a version column.
The condition must cover the facts that can invalidate the decision; pessimistic
locks remain available with an explicit reason and bounded scope.

## Alternatives

**Embed the complete policy in the organization rules.** The detailed guidance
would obscure the shorter layering and ownership rules. A separate owner keeps
the policy discoverable through a brief reference.

**Define optimistic concurrency only through version comparison.** This would
require version machinery for operations that only need to compare a current
state or another expected value. Versions remain appropriate when an operation
must detect changes beyond those values or preserve an existing version contract.

## Consequences

Reviewers have an explicit policy for business-rule placement, constraint costs
and concurrency guarantees. Application and Store tests retain separate proofs
of decisions and real database behavior.

The policy does not establish that every existing query or schema object already
conforms. Existing mechanisms and their original rationale remain documented by
their owners; changing them requires preserving their guarantees. This decision
changes documentation policy without changing SQL, schema or runtime behavior,
and makes no measured performance claim.
