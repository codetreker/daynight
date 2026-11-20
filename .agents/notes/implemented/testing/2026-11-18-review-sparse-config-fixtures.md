# Agent Note: Review Sparse Configuration Fixtures

Status: implemented

## Problem

The legacy sparse-primary fixtures start separate Git commands to write three
fixed Boolean values. The test cases need Git to populate and interpret the
sparse checkout and index. Writing each known value through its own process
adds setup cost to every configuration in the matrix.

## Decision

The [sparse fixture](../../../../packages/daynight/test/helpers/git-sparse-fixtures.ts)
appends the three fixed values together to the private common Git configuration.
It runs native `git sparse-checkout set` to establish the worktree and index
state and uses native `git config` to switch off worktree configuration in the
legacy mode. Both configuration modes read back all four effective settings
with one native Git command before testing production preparation.

## Alternatives

**Write each value with a separate Git command.** The configuration parser
already reads the fixture's fixed Boolean values together. The three
additional processes exercise the configuration writer outside the production
paths covered by these cases.

**Supply only the expected settings through a mock.** The production path
observes a real sparse index, skip-worktree entries, and filesystem contents.
A configuration mock could report the expected values without creating that
native state.

## Consequences

The legacy primary matrix launches nine fewer Git processes. The fixtures
verify the configurations Git actually uses, then exercise the real initial
and subsequent Review preparation. The tests continue to observe the
downstream reset, hidden-file contents, and primary checkout snapshots.
