# Agent Note: Review Owned Worktree Fixtures

Status: implemented

## Problem

The Review refresh, ownership, and administration tests often need a
previously registered review checkout. Running the full preparation path to
establish that starting state repeats the target capture, pinning, and checkout
workflow before the tested operation begins.

## Decision

The shared [Review Git fixture](../../../../packages/daynight/test/helpers/git-fixtures.ts)
fetches the case's private refs into the repository, pins the known base of
the linear fixture history, and creates a detached native worktree locked to
the Review Session. It registers the resulting checkout through the real
SQLite store. The selected tests then invoke the production refresh, cleanup,
or administration operation from that state.

The tests for initial creation, immutable base pinning, and captured Git object
interpretation still exercise full production preparation. The cleanup
diagnostic case retains its [native execution budget](2026-11-09-review-cleanup-diagnostic-budget.md)
and error chain assertions.

## Alternatives

**Use full preparation for every case.** This exercises creation repeatedly
even when the assertions begin after the checkout already exists.

**Replace native paths and locks with test doubles.** The cleanup and
administration assertions depend on actual Git registrations and changes to
the underlying filesystem. The shared fixture uses native Git to establish
that starting state.

## Consequences

The selected cases spend fewer native commands constructing their starting
state. Each case still owns its upstream, checkout, refs, and store. The
assertions on actual cleanup, admission, and the original HEAD, index, refs,
and files run through production operations.
