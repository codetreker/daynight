# Agent Note: Web quality command deadlines

Status: implemented

## Problem

A complete Vitest/V8 suite can pass near the end of its coverage command's shared
budget, leaving the strict raw-coverage checker unable to finish. Test-case
success does not establish that the generated report is complete or that its
strict statement gate passed. A single composite deadline couples two distinct
required results and obscures which command exhausted its allowance.

## Decision

The quality CI wrapper runs three commands serially with independent process
boundaries and deadlines:

| Command | Deadline |
| --- | --- |
| `pnpm --filter @codetreker/daynight-web test:harness` | 180 seconds |
| `pnpm --filter @codetreker/daynight-web exec vitest run --coverage` | 180 seconds |
| `pnpm --filter @codetreker/daynight-web exec node scripts/coverage.mts` | 60 seconds |

Only the Vitest/V8 child receives a copied environment with
`VITEST_MAX_WORKERS=4`. Its forks pool, per-file isolation, complete ordinary suite
and product-source manifest remain required. The checker still requires exact
unrounded statement coverage greater than 90%, validates report completeness and
fails on malformed or missing product files. Each command must succeed before
the next starts; cancellation and owned process-group cleanup keep their existing
failure semantics. Browser and Go gates remain mandatory.

The former 180-second composite Vitest/checker allowance becomes 180+60=240
seconds. Configured sequential quality command allowances therefore increase
from 360 to 420 seconds, while the quality job remains bounded at 20 minutes.
This aggregate is the sum of command allowances, not a claim about total job
elapsed time including preparation and cleanup. Local package test:coverage and
root web:test keep their existing composition and invocation.

This partially supersedes the command-budget policy in the [quality isolation
decision](2026-10-26-web-quality-job-isolation.md) and [worker capacity
decision](2026-10-28-web-quality-worker-capacity.md). Isolation originally kept
harness time outside a separate composite coverage deadline, and four workers
used the dedicated runner's capacity without changing that allowance. The
independent runners and worker rationale remain; the coverage boundary now names
V8 generation and strict checking separately. The [Web guide](../../../../packages/daynight-web/README.md)
and [development guide](../../../../docs/development.md#ci-selection) own commands
and validation responsibilities.

## Alternatives

**Keep the composite 180-second coverage deadline.** It preserves the previous
aggregate allowance but allows a successful suite to leave no usable time for
the mandatory strict checker. Separate command outcomes remain necessary to
establish completion of both stages.

**Increase only the composite limit.** A larger single deadline provides more
time but still couples suite generation and checker work. Independent limits
identify the failing command and prevent unused suite time from defining the
checker's entire budget.

## Consequences

The strict checker has an explicit opportunity to complete after successful V8
generation, and failures identify their command boundary. The configured
aggregate quality allowance increases by 60 seconds. No tests, assertions,
coverage thresholds, file isolation, browser scenarios or Go checks are removed.
The workflow keeps its existing 20-minute job limit and required final gate.

The suite can still exceed its own 180-second deadline, and the checker can still
fail or exceed 60 seconds. A timeout remains a failure requiring diagnosis; the
split does not establish a transient infrastructure cause or guarantee future
hosted duration. Source-bound run results and timing receipts remain with their
actual PR and CI run.
