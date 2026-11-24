# Agent Note: SQLite Migration Failure Logs

Status: implemented

## Problem

SQLite initialization and upgrades wrote start and completion records to CLI
and Worker logs. Successful commands already expose the outcome through their
normal return path. The extra records make failures harder to find.

## Decision

The stderr, Review, and Worker log reporters emit only migration failures.
The SQLite connection layer still supplies start, completion, and failure
events to internal callbacks. Controller uses the completion event to observe
the admitted storage state, as described by the
[journal observation decision](../architecture/2026-11-13-journal-version-observation.md).

## Alternatives

**Suppress start and completion events at the SQLite connection layer.** This
would also remove the Controller's completion observation and require a
separate way to capture the admitted storage state.

## Consequences

Memory and disk database initialization and upgrades are quiet on success.
Failure records retain their phase, version, transaction outcome, and error
details. The transaction and callback lifecycle remain available to callers.
