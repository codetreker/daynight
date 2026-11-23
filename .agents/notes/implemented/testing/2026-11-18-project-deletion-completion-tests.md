# Agent Note: Project Deletion Completion Tests

Status: implemented

## Problem

The deletion error matrix created a PostgreSQL schema to obtain a valid project
and owner. Its preview failures and transaction completion results came from
test-controlled sources. The database setup added work to scenarios whose
assertions concern error propagation and the reported outcome.

## Decision

Controlled snapshot facts provide the project and actor for preview and
preflight. The real Service reads those facts, executes preview stages, and
suppresses the result on a read error. A controlled deletion writer supplies
operation errors and completion states independently to the real outcome
classification. A commit without a receipt and a failed rollback cleanup both
require an unknown outcome.

Database-backed deletion tests retain the real preview projections,
authorization rechecks, and persisted rollback after scoped failures.

## Alternatives

**Keep the database for the preview and completion matrix.** It supplies the
principal and project but does not produce the injected errors or completion
outcomes.

**Replace physical rollback with a controlled completion.** A reported outcome
does not establish that the real deletion mark and resource changes reversed
and remained unchanged to an independent reader.

## Consequences

The error matrix can run without PostgreSQL. Real deletion and rollback
witnesses continue to execute in the isolated database suite.
