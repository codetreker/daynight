# Agent Note: Project Member Creation and Read Tests

Status: implemented

## Problem

The Project creation and membership tests built separate schemas to prepare
known actors, lists and transaction errors. This repeated real initialization
for cases that verify which project or caller the Service passes to a scope
and how it reports results.

## Decision

Controlled scope inputs let the real Service and Core code check project
creation, reads, member operations and invitation creation. They verify the
created UUID and metadata, canonical lookup, cursor position, full actor
identity including PAT kind and credential ID, and the original errors. A
failed insertion inside the callback has a separate completion result.

PostgreSQL tests keep creator grant insertion, actual rollback after a grant
error, closed-pool callback exclusion, PAT authentication, and SQL visibility
and pagination. The outsider's empty page is observed through real scoped
SQL. Remaining Project lifecycle and concurrency tests keep real persistence.

## Alternatives

**Use native login and creation for each accepted principal.** Production
authentication and storage produce valid facts, but repeating these operations
adds setup to tests of the next Service boundary. Real identity tests already
establish how the principal is obtained.

**Return results from an entire mocked Service.** That would remove the
operations whose context, caller identity, scope and failure handling these
tests verify.

## Consequences

The selected tests run without PostgreSQL. Real identity, SQL, and rollback
tests remain at their physical owners and use existing schemas.
