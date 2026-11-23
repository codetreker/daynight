# Agent Note: Bot Migration Test Budget

Status: implemented

## Problem

The legacy Bot checksummed-history migration test creates real SQLite and WAL
fixtures, migrates them, and checks original and copied files. A [Windows CI
run](https://github.com/codetreker/daynight/actions/runs/45203110189/job/137793112463)
reported 5,043.9 ms for the v17 case, exceeding Vitest's default 5,000 ms
limit. Its log did not identify a slow migration phase or a production defect.

## Decision

The shared v16 and v17 checksummed-history migration cases use a 15,000 ms
test timeout. The real fixtures, byte and checksum checks, recovery bindings,
and repeated reads remain in place. Its cleanup aborts and waits for the case's
asynchronous work before releasing fixture handles, the Worker lock and files;
Vitest's timeout alone does not stop that work. Other cases and the global
Vitest budget retain their existing limits.

## Alternatives

**Keep the default timeout.** The observed complete Windows case exceeded it,
although the test did not report a migration or cleanup error.

**Optimize a slow phase.** The available log does not identify which phase
consumed the budget, so it does not support a targeted optimization.

## Consequences

The finite limit allows more room for runner variation, but takes longer to
report a stalled case. It does not establish a performance improvement or a
cause for the observed delay. The production migration and its evidence
preservation remain governed by the [migration decision](../architecture/2026-11-19-bot-storage-migration.md).
